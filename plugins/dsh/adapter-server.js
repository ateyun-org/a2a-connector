import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const WORKING = 'TASK_STATE_WORKING';
const DEFAULT_DESCRIPTION = 'DSH native session adapter; text tasks and multi-turn contexts.';
const DEFAULT_SKILLS = [{ id: 'dsh', name: 'DSH tasks',
  description: 'Execute tasks using the configured DSH profile.', tags: ['dsh'] }];
const view = task => ({ id: task.id, contextId: task.contextId,
  status: { state: task.state, message: { messageId: task.id, contextId: task.contextId,
    role: 'ROLE_AGENT', parts: [{ text: task.output, mediaType: 'text/plain' }] } }, artifacts: [] });

/** Loopback A2A v1.0 text endpoint. createSession returns { run, cancel, dispose }. */
export function createAdapterServer({ token, createSession, name = 'DSH Agent',
  description = DEFAULT_DESCRIPTION, skills = DEFAULT_SKILLS,
  maxContexts = 128, maxTasks = 4096, idleMs = 3600000, maxRequestBodyBytes = 1048576 }) {
  if (!Number.isInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1 || maxRequestBodyBytes > 16777216) throw new Error('Invalid maxRequestBodyBytes');
  if (typeof token !== 'string' || token.length < 32) throw new Error('DSH adapter token must contain at least 32 characters');
  if (typeof description !== 'string' || !description.trim() || !Array.isArray(skills) ||
      skills.some(skill => !skill || typeof skill.id !== 'string' || !skill.id ||
        typeof skill.name !== 'string' || !skill.name ||
        typeof skill.description !== 'string' || !skill.description ||
        !Array.isArray(skill.tags) || skill.tags.some(tag => typeof tag !== 'string'))) {
    throw new Error('DSH adapter requires a description and valid Agent Card skills');
  }
  const contexts = new Map();
  const tasks = new Map();
  let closing = false;
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(401, { error: 'unauthorized' }); return;
    }
    if (closing) { json(503, { error: 'shutting_down' }); return; }
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      json(200, { name, description, version: '1.0.0',
        supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
        skills });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { json(404, { error: 'not_found' }); return; }
    let body;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBodyBytes) { json(413, { error: 'body_too_large' }); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { json(400, { error: 'invalid_json' }); return; }
    const id = typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null;
    const error = (code, message) => json(200, { jsonrpc: '2.0', id, error: { code, message } });
    const reply = result => json(200, { jsonrpc: '2.0', id, result });
    if (body?.jsonrpc !== '2.0' || id === null) { error(-32600, 'Invalid request'); return; }
    const params = body.params ?? {};
    if (body.method === 'SendMessage') {
      const msg = params.message;
      if (!msg || msg.role !== 'ROLE_USER' || !Array.isArray(msg.parts) || !msg.parts.length ||
          msg.parts.some(part => typeof part?.text !== 'string') || !msg.parts.some(part => part.text.trim()) ||
          (msg.contextId && typeof msg.contextId !== 'string')) {
        error(-32602, 'A non-empty user text message is required'); return;
      }
      if (msg.taskId) { error(-32602, 'This adapter completes tasks; continue using contextId without taskId'); return; }
      if (tasks.size >= maxTasks) { error(-32000, 'Task capacity reached; wait for idle context expiry'); return; }
      const contextId = msg.contextId || randomUUID();
      let context = contexts.get(contextId);
      if (msg.contextId && !context) { error(-32602, 'Unknown or expired contextId; start a new conversation'); return; }
      if (context?.busy) { error(-32000, 'Context already has an active task'); return; }
      if (!context) {
        if (contexts.size >= maxContexts) { error(-32000, 'Context capacity reached'); return; }
        context = { busy: false, touched: Date.now() };
        contexts.set(contextId, context);
      }
      // Reserve synchronously before any await: concurrent sends cannot share a running session.
      context.busy = true;
      const task = { id: randomUUID(), contextId, state: WORKING, output: '' };
      tasks.set(task.id, task);
      task.done = (async () => {
        try {
          context.session ??= await createSession(contextId);
          if (closing || task.state !== WORKING) return;
          const outcome = await context.session.run(msg.parts.map(part => part.text).join('\n'));
          if (task.state === WORKING) {
            task.output = String(outcome.text ?? '').slice(0, 1024 * 1024);
            task.state = outcome.completed ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED';
          }
        } catch {
          if (task.state === WORKING) { task.state = 'TASK_STATE_FAILED'; task.output = 'DSH task failed; inspect local DSH diagnostics.'; }
        } finally { context.busy = false; context.touched = Date.now(); }
      })();
      reply({ task: view(task) }); return;
    }
    if (body.method === 'GetTask' || body.method === 'CancelTask') {
      const task = tasks.get(params.id);
      if (!task) { error(-32001, 'Task not found'); return; }
      if (body.method === 'CancelTask' && task.state === WORKING) {
        task.state = 'TASK_STATE_CANCELED';
        try { contexts.get(task.contextId)?.session?.cancel(); } catch { /* run still owns settlement */ }
      }
      reply(view(task)); return;
    }
    if (body.method === 'ListTasks') {
      if (params.pageToken) { error(-32602, 'Pagination is not supported'); return; }
      reply({ tasks: [...tasks.values()].filter(task => !params.contextId || task.contextId === params.contextId).map(view), nextPageToken: '' }); return;
    }
    error(-32601, 'Method not found');
  });
  server.requestTimeout = 30000;
  const expire = async () => {
    for (const [id, context] of contexts) {
      if (context.busy || Date.now() - context.touched < idleMs) continue;
      contexts.delete(id);
      for (const [key, task] of tasks) if (task.contextId === id) tasks.delete(key);
      await context.session?.dispose();
    }
  };
  const timer = setInterval(() => { void expire().catch(() => {}); }, Math.min(idleMs, 60000));
  timer.unref();
  return { server, async close() {
    closing = true;
    clearInterval(timer);
    const stopped = new Promise(resolve => server.close(resolve));
    for (const task of tasks.values()) if (task.state === WORKING) task.state = 'TASK_STATE_CANCELED';
    for (const context of contexts.values()) context.session?.cancel();
    await Promise.allSettled([...tasks.values()].map(task => task.done));
    await Promise.allSettled([...contexts.values()].map(context => context.session?.dispose()));
    await stopped;
  } };
}
