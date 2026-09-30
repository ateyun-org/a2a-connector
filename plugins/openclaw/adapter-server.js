import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const WORKING = 'TASK_STATE_WORKING';
const LIMIT = 1024 * 1024;

/** A2A 1.0 text tasks backed by public OpenClaw CLI sessions. */
export function createAdapterServer({ token, createSession, name = 'OpenClaw Agent',
  agent = 'main', maxTasks = 4096, maxContexts = 128, idleMs = 3600000 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Adapter token must contain at least 32 characters');
  const tasks = new Map(), contexts = new Map();
  const expected = Buffer.from(`Bearer ${token}`);
  let closing = false;
  const view = task => ({ id: task.id, contextId: task.contextId,
    status: { state: task.state, timestamp: task.updated,
      ...(task.output ? { message: { messageId: task.id, role: 'ROLE_AGENT',
        parts: [{ text: task.output }] } } : {}) },
    artifacts: task.state === 'TASK_STATE_COMPLETED'
      ? [{ artifactId: task.id, parts: [{ text: task.output }] }] : [] });
  const server = createServer(async (req, res) => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(401, { error: 'unauthorized' }); return;
    }
    if (closing) { json(503, { error: 'shutting_down' }); return; }
    if (req.method === 'GET' && ['/.well-known/agent-card.json', '/.well-known/agent.json'].includes(req.url)) {
      json(200, { name, description: `OpenClaw ${agent} agent; text tasks and conversation contexts.`, version: '1.0.0',
        supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/a2a/v1`,
          protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {},
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
        skills: [{ id: agent, name: `${agent} tasks`, description: 'Execute tasks using this OpenClaw agent.', tags: ['openclaw'] }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/a2a/v1') { json(404, { error: 'not_found' }); return; }
    let body;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMIT) { json(413, { error: 'body_too_large' }); return; }
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
      if (!msg || msg.role !== 'ROLE_USER' || typeof msg.messageId !== 'string' || !msg.messageId ||
          !Array.isArray(msg.parts) || !msg.parts.length || msg.parts.some(p => typeof p?.text !== 'string') ||
          !msg.parts.some(p => p.text.trim()) ||
          (msg.contextId !== undefined && (typeof msg.contextId !== 'string' || !msg.contextId || msg.contextId.length > 128))) {
        error(-32602, 'A non-empty user text message with messageId is required'); return;
      }
      if (msg.taskId) { error(-32602, 'Continue completed tasks using contextId without taskId'); return; }
      const contextId = msg.contextId || randomUUID();
      let context = contexts.get(contextId);
      if (msg.contextId && !context) { error(-32602, 'Unknown or expired contextId'); return; }
      // Replayed messages do not dispatch the same tools twice while the context is retained.
      const duplicate = context?.messages.get(msg.messageId);
      if (duplicate) {
        if (duplicate.input !== JSON.stringify(msg.parts)) { error(-32602, 'messageId reused with different input'); return; }
        reply({ task: view(duplicate) }); return;
      }
      if (context?.busy) { error(-32000, 'Context already has an active task'); return; }
      if (tasks.size >= maxTasks || (!context && contexts.size >= maxContexts)) {
        error(-32000, 'Adapter capacity reached; wait for idle context expiry'); return;
      }
      if (!context) {
        context = { busy: false, touched: Date.now(), messages: new Map() };
        contexts.set(contextId, context);
      }
      context.busy = true;
      const task = { id: randomUUID(), contextId, state: WORKING, output: '',
        updated: new Date().toISOString(), input: JSON.stringify(msg.parts) };
      tasks.set(task.id, task);
      context.messages.set(msg.messageId, task);
      task.done = (async () => {
        try {
          context.session ??= await createSession(contextId);
          const output = await context.session.run(msg.parts.map(p => p.text).join('\n'));
          if (typeof output !== 'string' || !output.trim() || Buffer.byteLength(output) > LIMIT) throw new Error('Invalid agent output');
          task.output = output;
          task.state = 'TASK_STATE_COMPLETED';
        } catch {
          task.output = 'OpenClaw task failed; inspect local Gateway diagnostics.';
          task.state = 'TASK_STATE_FAILED';
        } finally {
          task.updated = new Date().toISOString();
          context.busy = false; context.touched = Date.now();
        }
      })();
      // Non-blocking results let Relay clients poll without holding the tunnel open.
      if (params.configuration?.blocking === true) await task.done;
      reply({ task: view(task) }); return;
    }
    if (body.method === 'GetTask' || body.method === 'tasks/get') {
      const task = tasks.get(params.id);
      if (!task) { error(-32001, 'Task not found'); return; }
      reply(view(task)); return;
    }
    // Killing the CLI cannot prove that the Gateway stopped using tools.
    if (body.method === 'CancelTask' || body.method === 'tasks/cancel') {
      error(-32004, 'Cancellation is not supported by the OpenClaw CLI adapter'); return;
    }
    error(-32601, 'Method not found');
  });
  server.requestTimeout = 30000;
  const timer = setInterval(() => {
    for (const [id, context] of contexts) {
      if (context.busy || Date.now() - context.touched < idleMs) continue;
      contexts.delete(id);
      for (const task of context.messages.values()) tasks.delete(task.id);
    }
  }, Math.min(idleMs, 60000));
  timer.unref();
  return { server, async close() {
    closing = true;
    clearInterval(timer);
    const stopped = new Promise(resolve => server.close(resolve));
    // Disconnect HTTP callers; a CLI-owned Gateway run may still be executing.
    // Never report cancellation when there is no confirmed Gateway abort seam.
    server.closeAllConnections();
    await stopped;
  } };
}

export async function listenAdapter(server, startPort = 9900, attempts = 20) {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535 ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 100) throw new Error('Invalid adapter port range');
  for (let port = startPort; port < Math.min(startPort + attempts, 65536); port++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = err => { server.off('listening', ready); reject(err); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (err) { if (err.code !== 'EADDRINUSE') throw err; }
  }
  throw new Error('No free OpenClaw adapter port');
}
