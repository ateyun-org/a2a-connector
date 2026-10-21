import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { CloudAPI } from '../../plugins/workbuddy/cloud-api.js';
import { ACPClient } from '../../plugins/workbuddy/acp-client.js';

export async function cloudProvider(t, options = {}) {
  const sessions = new Map(), connections = new Map(), prompts = [], creations = [], calls = [], replies = [];
  let rejectedToken = false;
  const emit = (res, message) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\r\n\r\n`);
  const finish = (stream, request, stopReason = options.stopReason || 'end_turn') => {
    if (options.providerEndTurn) {
      for (const meta of [{ 'codebuddy.ai': { requestId: 'unrelated-provider-turn' } },
        { 'codebuddy.ai': { requestId: `provider-${request.id}`, mode: 'history' } }]) {
        emit(stream, { method: 'session/update', params: { sessionId: request.params.sessionId, _meta: meta,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG PROVIDER OR HISTORY' } } } });
      }
    }
    emit(stream, { method: 'session/update', params: { sessionId: 'unrelated', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG' } } } });
    emit(stream, { method: 'session/update', params: { sessionId: request.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '云端实际结果' } } } });
    for (const [event, text] of [['created', 'draft'], ['updated', 'verified artifact']]) {
      emit(stream, { method: '_codebuddy.ai/artifact', params: { sessionId: request.params.sessionId, event,
        artifact: { uri: 'agent:///artifacts/result.md', name: 'result.md', type: 'overview', text } } });
    }
    sessions.get(request.params.sessionId).status = 'completed';
    if (options.providerEndTurn) {
      for (const requestId of ['unrelated-provider-turn', `provider-${request.id}`]) {
        emit(stream, { method: 'session/endTurn', params: { sessionId: request.params.sessionId,
          stopReason, _meta: { 'codebuddy.ai': { requestId } } } });
      }
      return;
    }
    emit(stream, { id: request.id, result: { stopReason } });
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/openapi/v2/')) {
      assert.equal(req.headers.authorization, 'Bearer oauth-secret');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/openapi/v2/tasks' && req.method === 'GET') {
        res.end(JSON.stringify({ tasks: [...sessions.values()].map(({ token, ...value }) => value), total: sessions.size })); return;
      }
      if (url.pathname === '/openapi/v2/tasks' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); creations.push(body);
        if (options.uncertainCreate) { req.socket.destroy(); return; }
        const id = `cloud-${sessions.size + 1}`;
        const task = { task_id: id, name: body.name, status: options.createdStatus || 'completed', token: 'acp-secret', link: `${origin}/sessions/${id}` };
        sessions.set(id, task); res.writeHead(201); res.end(JSON.stringify(task)); return;
      }
      const id = url.pathname.split('/').at(-1);
      if (sessions.has(id)) { res.end(JSON.stringify(sessions.get(id))); return; }
      res.writeHead(404); res.end('{}'); return;
    }
    assert.equal(req.headers.authorization, 'Bearer acp-secret');
    if (url.pathname === '/api/session/artifacts') {
      const id = url.searchParams.get('sessionId');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, data: { sessionId: id, artifacts: options.artifactEntries || [],
        pagination: { hasMore: false } } })); return;
    }
    const id = url.pathname.split('/').at(-1);
    if (!sessions.has(id)) { res.writeHead(404); res.end(); return; }
    if (req.method === 'GET') {
      if (options.expiredOnce && !rejectedToken) { rejectedToken = true; res.writeHead(401); res.end(); return; }
      const cid = `connection-${connections.size + 1}`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'Acp-Connection-Id': cid });
      res.flushHeaders(); connections.set(cid, res);
      res.on('close', () => connections.delete(cid)); return;
    }
    const stream = connections.get(req.headers['acp-connection-id']);
    assert.ok(stream);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw); calls.push(rpc);
    if (options.gatewayQuirks) {
      assert.match(req.headers.accept, /application\/json/);
      assert.match(req.headers.accept, /text\/event-stream/);
      assert.equal(typeof rpc.id, 'number');
    }
    if (rpc.method === 'session/load' && options.rejectLoad) { res.writeHead(400); res.end(); return; }
    if (rpc.method === 'session/prompt' && options.rejectPrompt) {
      prompts.push(rpc); res.writeHead(401); res.end(); return;
    }
    res.writeHead(202); res.end();
    if (rpc.method === 'initialize') emit(stream, { id: rpc.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (rpc.method === 'session/load') {
      for (const event of options.replayEvents || []) emit(stream, event);
      if (options.gatewayQuirks) {
        stream.write('data: {"jsonrpc":"","method":"_codebuddy.ai/loadHeartbeat","params":{}}\r\n\r\n');
        stream.write(`data: ${JSON.stringify({ jsonrpc: '', method: 'session/update', params: {
          sessionId: id, update: { sessionUpdate: 'session_info_update' } } })}\r\n\r\n`);
      }
      emit(stream, { method: 'session/update', params: { sessionId: id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } } } });
      emit(stream, { id: rpc.id, result: {} });
    } else if (rpc.method === 'session/prompt') {
      prompts.push(rpc); sessions.get(id).status = 'working';
      if (options.providerEndTurn) emit(stream, { method: 'session/update', params: { sessionId: id,
        _meta: { 'codebuddy.ai': { requestId: `provider-${rpc.id}`, mode: 'live' } },
        update: { sessionUpdate: 'user_message_chunk', content: rpc.params.prompt[0] } } });
      if (options.disconnect) { stream.end(); return; }
      if (options.permission) {
        options.waiting = { stream, rpc };
        emit(stream, { id: 'permission-1', method: 'session/request_permission', params: { sessionId: id,
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
          toolCall: { title: 'Write requested report', toolCallId: 'tool-1' } } });
      } else if (!options.hold) finish(stream, rpc);
      else options.waiting = { stream, rpc };
    } else if (rpc.method === 'session/cancel') finish(stream, options.waiting.rpc, 'cancelled');
    else if (!rpc.method) {
      replies.push(rpc);
      if (rpc.result?.outcome?.outcome === 'selected') finish(stream, options.waiting.rpc);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  sessions.set('existing', { task_id: 'existing', status: 'idle', token: 'acp-secret', link: `${origin}/sessions/existing` });
  t.after(async () => { for (const stream of connections.values()) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const api = new CloudAPI({ accessToken: async () => ({ accessToken: 'oauth-secret', scope: 'user.task.readable user.task.invokable' }),
    baseURL: `${origin}/openapi/v2/`, allowInsecure: true });
  return { api, sessions, creations, prompts, calls, replies, origin,
    clientFactory: args => new ACPClient({ ...args, allowInsecure: true }) };
}
