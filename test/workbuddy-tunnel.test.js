import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Connector } from '../src/connector.js';
import { DesktopAPI } from '../plugins/workbuddy/desktop-api.js';
import { DesktopBridge } from '../plugins/workbuddy/desktop-bridge.js';
import { TaskStore } from '../plugins/workbuddy/task-store.js';
import { createWorkBuddyAdapter } from '../plugins/workbuddy/adapter-server.js';
import { callAgent } from '../plugins/workbuddy/a2a-client.js';
import { CloudBridge } from '../plugins/workbuddy/cloud-bridge.js';
import { cloudProvider } from './helpers/workbuddy-cloud.js';

for (const mode of ['desktop', 'cloud']) test(`A2A request traverses the real Connector tunnel, authenticated adapter and ${mode} API and returns its result`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-tunnel-'));
  const history = [];
  let executions = 0;
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer provider-token');
    let data;
    if (req.url === '/openapi/v2/localassistant') data = { online: true };
    else if (req.method === 'POST') {
      executions++;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const sent = JSON.parse(raw);
      const id = /^\[A2A_TASK:([^\]]+)\]/.exec(sent.content)[1];
      history.push({ message_id: 'user-1', role: 'user', msg_type: 'text', content: [sent.content] }, {
        message_id: 'assistant-1', role: 'assistant', msg_type: 'text', content: [JSON.stringify({ a2aTaskId: id,
          status: 'completed', text: 'task output from the desktop API' })],
      });
      data = { message_id: 'user-1' };
    } else data = { messages: history.filter(value => value.role === 'assistant') };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const api = new DesktopAPI({ accessToken: async () => ({ accessToken: 'provider-token', scope: 'user.localassistant.readable user.localassistant.invokable' }),
    baseURL: `http://127.0.0.1:${provider.address().port}/openapi/v2/`, allowInsecure: true });
  const cloud = mode === 'cloud' ? await cloudProvider(t) : null;
  const bridge = cloud ? new CloudBridge({ ...cloud, store: new TaskStore(join(directory, 'tasks.json')) })
    : new DesktopBridge({ api, store: new TaskStore(join(directory, 'tasks.json')), pollIntervalMs: 5 });
  await bridge.start();
  const adapter = createWorkBuddyAdapter({ bridge, token: 'local-secret'.repeat(4) });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  let socket;
  const pending = new Map();
  const relay = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer controller-token');
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/agent-card.json')) {
      const card = await (await fetch(`http://127.0.0.1:${adapter.server.address().port}/.well-known/agent-card.json`, {
        headers: { authorization: `Bearer ${'local-secret'.repeat(4)}` },
      })).json();
      card.supportedInterfaces[0].url = `http://127.0.0.1:${relay.address().port}/agents/workbuddy/rpc`;
      res.end(JSON.stringify(card)); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const id = randomUUID();
    pending.set(id, { res, chunks: [] });
    socket.send(JSON.stringify({ type: 'request.start', requestId: id, method: 'POST', path: '/rpc',
      headers: { Authorization: ['Bearer must-not-reach-local-adapter'] } }));
    socket.send(JSON.stringify({ type: 'request.body', requestId: id, body: Buffer.from(raw).toString('base64') }));
    socket.send(JSON.stringify({ type: 'request.end', requestId: id }));
  });
  const wss = new WebSocketServer({ noServer: true });
  const connected = new Promise(resolve => wss.once('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const frame = JSON.parse(raw);
      const item = pending.get(frame.requestId);
      if (frame.type === 'response.start') item.status = frame.status;
      if (frame.type === 'response.body') item.chunks.push(Buffer.from(frame.body, 'base64'));
      if (frame.type === 'response.end') {
        item.res.writeHead(item.status);
        item.res.end(Buffer.concat(item.chunks));
        pending.delete(frame.requestId);
      }
    });
    resolve();
  }));
  relay.on('upgrade', (req, stream, head) => {
    assert.equal(req.headers.authorization, 'Bearer connector-token');
    wss.handleUpgrade(req, stream, head, ws => wss.emit('connection', ws));
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const relayURL = `ws://127.0.0.1:${relay.address().port}/connect`;
  const connector = new Connector({ relay: relayURL, local: `http://127.0.0.1:${adapter.server.address().port}`,
    token: 'connector-token', localToken: 'local-secret'.repeat(4), allowInsecure: true });
  const controller = new AbortController();
  const tunnel = connector.connectOnce(controller.signal);
  t.after(async () => {
    controller.abort();
    await tunnel;
    await adapter.close();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => relay.close(resolve));
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await connected;
  const result = await callAgent({ relay: relayURL, allowInsecure: true,
    enrollment: { agentId: 'controller', token: 'controller-token' }, targetId: 'workbuddy', prompt: 'produce a result', pollIntervalMs: 5 });
  assert.equal(result.state, 'TASK_STATE_COMPLETED');
  assert.equal(result.text, cloud ? '云端实际结果' : 'task output from the desktop API');
  assert.equal(cloud ? cloud.prompts.length : executions, 1);
  if (cloud) {
    const followup = await callAgent({ relay: relayURL, allowInsecure: true,
      enrollment: { agentId: 'controller', token: 'controller-token' }, targetId: 'workbuddy',
      prompt: 'continue the same session', contextId: result.contextId, pollIntervalMs: 5 });
    assert.equal(followup.state, 'TASK_STATE_COMPLETED');
    assert.equal(followup.metadata.remoteTaskId, result.metadata.remoteTaskId);
    assert.equal(cloud.creations.length, 1); assert.equal(cloud.prompts.length, 2);
    assert.equal(followup.artifacts.length, 2);
  }
});
