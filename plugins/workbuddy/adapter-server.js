import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { BridgeError } from './desktop-bridge.js';

export function taskView(task) {
  const message = { messageId: task.resultMessageId || task.id, contextId: task.contextId,
    role: 'ROLE_AGENT', parts: [{ text: task.output || '', mediaType: 'text/plain' }] };
  return { id: task.id, contextId: task.contextId, status: { state: task.state, timestamp: task.updatedAt, message },
    artifacts: [...(task.state === 'TASK_STATE_COMPLETED' ? [{ artifactId: task.id, name: 'WorkBuddy result', parts: message.parts }] : []),
      ...(task.artifacts || []).map(artifact => ({ artifactId: artifact.uri, name: artifact.name || artifact.title || artifact.uri,
        parts: [{ text: artifact.text || artifact.uri, mediaType: artifact.text ? artifact.mimeType || 'text/plain' : 'text/plain' }],
        metadata: { providerURI: artifact.uri, type: artifact.type, mimeType: artifact.mimeType } }))],
    metadata: { dispatchState: task.dispatchState, remoteMessageId: task.remoteMessageId,
      mode: task.mode || 'desktop', sharedDesktopConversation: task.mode !== 'cloud',
      ...(task.providerState ? { providerState: task.providerState } : {}),
      ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
      ...(task.mode === 'cloud' ? { remoteTaskId: task.remoteTaskId, sharedCloudSession: task.sharedCloudSession,
        cloudName: task.cloudName, stopReason: task.stopReason, permission: task.permission, trackingReleased: task.trackingReleased } : {}),
      ...(task.lastPollError ? { lastPollError: task.lastPollError } : {}) } };
}

export function createWorkBuddyAdapter({ token, bridge, name = 'WorkBuddy Desktop', maxBodyBytes = 1024 * 1024 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('WorkBuddy adapter token must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const supplied = Buffer.from(req.headers.authorization || '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { json(401, { error: 'unauthorized' }); return; }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      const cloud = bridge.mode === 'cloud';
      json(200, { name, description: cloud ? 'WorkBuddy cloud task execution through authorized Open API and ACP; durable serialized turns, explicit approvals and authoritative completion.' : 'WorkBuddy PC local assistant via authorized Open API; serialized text tasks, durable tracking and explicit result correlation. Desktop approvals remain interactive.',
        version: '1.0.0', supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
        skills: [{ id: cloud ? 'workbuddy-cloud' : 'workbuddy-desktop', name: cloud ? 'Cloud task execution' : 'Desktop task execution', description: 'Execute authorized WorkBuddy tasks and return verified task results.', tags: ['workbuddy', cloud ? 'cloud' : 'desktop', 'tasks'] }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { json(404, { error: 'not_found' }); return; }
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) { json(413, { error: 'body_too_large' }); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { json(400, { error: 'invalid_json' }); return; }
    const id = typeof body?.id === 'string' || (typeof body?.id === 'number' && Number.isFinite(body.id)) ? body.id : null;
    const reply = result => json(200, { jsonrpc: '2.0', id, result });
    const error = (code, message) => json(200, { jsonrpc: '2.0', id, error: { code, message } });
    if (body?.jsonrpc !== '2.0' || id === null) { error(-32600, 'Invalid request'); return; }
    const params = body.params || {};
    try {
      if (['SendMessage', 'message/send'].includes(body.method)) {
        reply({ task: taskView(await bridge.submit(params.message)) }); return;
      }
      if (['GetTask', 'tasks/get'].includes(body.method)) { reply(taskView(await bridge.get(params.id))); return; }
      if (body.method === 'ListTasks') {
        if (params.pageToken) throw new BridgeError(-32602, 'Pagination is not supported');
        reply({ tasks: (await bridge.store.list()).filter(task => !params.contextId || task.contextId === params.contextId).map(taskView), nextPageToken: '' }); return;
      }
      if (['CancelTask', 'tasks/cancel'].includes(body.method)) {
        if (bridge.cancel) { reply(taskView(await bridge.cancel(params.id))); return; }
        throw new BridgeError(-32002, 'WorkBuddy localassistant has no cancellation API; cancel in the desktop and keep tracking this task');
      }
      if (body.method === 'RespondPermission' && bridge.respondPermission) {
        reply(taskView(await bridge.respondPermission(params.id, params.requestId, params.optionId))); return;
      }
      if (body.method === 'ReleaseCloudTask' && bridge.release) {
        reply(taskView(await bridge.release(params.id, params.cloudTaskId))); return;
      }
      error(-32601, 'Method not found');
    } catch (failure) {
      error(failure instanceof BridgeError ? failure.code : -32603,
        failure instanceof BridgeError ? failure.message : 'WorkBuddy task journal unavailable; inspect local diagnostics');
    }
  });
  server.requestTimeout = 30000;
  return { server, async close() {
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    await bridge.close();
    await stopped;
  } };
}
