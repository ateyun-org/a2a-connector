import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

export const MAX_BODY = 16 * 1024 * 1024;
const CHUNK_SIZE = 32 * 1024;
const blockedHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'authorization']);
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function assertURL(value, schemes, path, name) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!schemes.includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password || parsed.hash ||
      parsed.search || (path === null ? parsed.pathname !== '/' : parsed.pathname !== path)) {
    throw new Error(`${name} must be a ${schemes.join(' or ')} ${path || 'origin'} URL`);
  }
  return parsed;
}

function relayHTTPURL(relay, path, allowInsecure) {
  const url = assertURL(relay, ['wss:', 'ws:'], '/connect', 'relay');
  if (url.protocol === 'ws:' && !allowInsecure) throw new Error('relay requires WSS');
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  return url;
}

function boundedSignal(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function validateConfig(config) {
  const relay = assertURL(config.relay, ['wss:', 'ws:'], '/connect', 'relay');
  if (relay.protocol === 'ws:' && !config.allowInsecure) throw new Error('relay requires WSS');
  const local = assertURL(config.local, ['http:', 'https:'], null, 'local');
  if (!config.token) throw new Error('connector token is required');
  return { relay, local };
}

export function statePath() {
  const base = platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : platform() === 'win32' ? (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
  return join(base, 'a2a-connector', 'state.json');
}

export async function register({ relay, code, allowInsecure = false, signal }) {
  const url = relayHTTPURL(relay, '/register', allowInsecure);
  if (!/^pair_[0-9a-f]{48}$/.test(code || '')) throw new Error('pairing code is required');
  const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: boundedSignal(signal, 15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  if (response.status !== 201) throw new Error(`relay registration status ${response.status}`);
  const enrollment = await response.json();
  if (!enrollment.agentId || !enrollment.token) throw new Error('relay registration response missing identity');
  return { agentId: enrollment.agentId, token: enrollment.token, card: enrollment.card };
}

export async function requestPairing({ relay, agentId, name, allowInsecure = false, signal }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId || '') || !name || name.length > 120) {
    throw new Error('valid Agent ID and name are required');
  }
  const url = relayHTTPURL(relay, '/pairing/requests', allowInsecure);
  const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: boundedSignal(signal, 15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, name }) });
  if (response.status !== 201) throw new Error(`pairing request status ${response.status}`);
  const request = await response.json();
  if (!/^[0-9a-f]{64}$/.test(request.requestId || '') || !/^[0-9A-F]{6}$/.test(request.confirmationCode || '')) {
    throw new Error('relay pairing response is incomplete');
  }
  return request;
}

export async function pairingStatus({ relay, requestId, allowInsecure = false, signal }) {
  if (!/^[0-9a-f]{64}$/.test(requestId || '')) throw new Error('invalid pairing request ID');
  const url = relayHTTPURL(relay, '/pairing/status', allowInsecure);
  const response = await fetch(url, { method: 'POST', redirect: 'manual', signal: boundedSignal(signal, 15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }) });
  if (response.status === 404) return { status: 'expired' };
  if (response.status !== 200) throw new Error(`pairing status ${response.status}`);
  const status = await response.json();
  if (status.status === 'approved' && /^pair_[0-9a-f]{48}$/.test(status.code || '')) return status;
  if (status.status === 'pending') return status;
  throw new Error('invalid relay pairing status');
}

export async function waitForPairing({ relay, requestId, allowInsecure = false, signal, interval = 3000 }) {
  for (;;) {
    const status = await pairingStatus({ relay, requestId, allowInsecure, signal });
    if (status.status !== 'pending') return status;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, interval);
      function onAbort() { clearTimeout(timer); reject(signal.reason || new Error('aborted')); }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function saveEnrollment(path, enrollment) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.state-${randomBytes(8).toString('hex')}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(enrollment));
    await file.sync();
  } finally { await file.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

export async function loadPendingPairing(path) {
  const info = await stat(path);
  if (platform() !== 'win32' && (info.mode & 0o077)) throw new Error('pending pairing file must be private (0600)');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(value.requestId || '') || !/^[0-9A-F]{6}$/.test(value.confirmationCode || '') ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.agentId || '')) throw new Error('pending pairing file is invalid');
  return value;
}

export async function loadEnrollment(path) {
  const info = await stat(path);
  if (platform() !== 'win32' && (info.mode & 0o077)) throw new Error('connector state file must be private (0600)');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value.agentId || !value.token) throw new Error('connector state is incomplete');
  return value;
}

function copyHeaders(source) {
  const result = {};
  for (const [key, values] of Object.entries(source || {})) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    result[key] = Array.isArray(values) ? values : [values];
  }
  return result;
}

async function limitedBody(response, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error('response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function send(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('relay disconnected');
  socket.send(JSON.stringify(frame));
}

function sendBody(socket, kind, id, body) {
  for (let offset = 0; offset < body.length; offset += CHUNK_SIZE) {
    send(socket, { type: `${kind}.body`, requestId: id,
      body: body.subarray(offset, offset + CHUNK_SIZE).toString('base64') });
  }
  send(socket, { type: `${kind}.end`, requestId: id });
}

function replyError(socket, id, status) {
  try {
    send(socket, { type: 'response.start', requestId: id, status,
      headers: { 'Content-Type': ['application/json'] } });
    sendBody(socket, 'response', id, Buffer.from(JSON.stringify({ error: 'local_agent_error', status })));
  } catch { /* connection closed */ }
}

export class Connector {
  constructor(config) {
    const { relay, local } = validateConfig(config);
    this.config = { ...config, relay: relay.toString(), local: local.toString() };
  }

  async discover(signal) {
    const url = new URL('/.well-known/agent-card.json', this.config.local);
    const headers = this.config.localToken ? { authorization: `Bearer ${this.config.localToken}` } : {};
    const response = await fetch(url, { headers, redirect: 'manual', signal: boundedSignal(signal, 60000) });
    if (response.status !== 200) throw new Error(`Agent Card status ${response.status}`);
    const card = JSON.parse((await limitedBody(response, 1 << 20)).toString());
    if (!card?.name) throw new Error('Agent Card has no name');
    return card;
  }

  async run(signal) {
    let delay = 1000;
    while (!signal?.aborted) {
      try {
        await this.discover(signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : undefined);
        await this.connectOnce(signal);
        delay = 1000;
      } catch (error) {
        if (!signal?.aborted) console.warn(`A2A Connector: ${error.message}`);
      }
      if (signal?.aborted) break;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay + Math.floor(Math.random() * delay / 4));
        signal?.addEventListener('abort', finish, { once: true });
      });
      delay = Math.min(delay * 2, this.config.maxDelay || 30000);
    }
  }

  connectOnce(signal) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.relay, { headers: { Authorization: `Bearer ${this.config.token}` },
        maxPayload: 128 * 1024, perMessageDeflate: false, handshakeTimeout: 10000 });
      const pending = new Map();
      const active = new Set();
      let opened = false;
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 25000);
      const onAbort = () => socket.terminate();
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('pong', () => { alive = true; });
      socket.on('open', () => { opened = true; });
      socket.on('message', raw => {
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { socket.close(1002, 'invalid frame'); return; }
        if (!frame.requestId || !frame.type) { socket.close(1002, 'invalid frame'); return; }
        switch (frame.type) {
          case 'request.start':
            if (allowedMethods.has(frame.method) && pending.size < 256) pending.set(frame.requestId, { start: frame, chunks: [], size: 0 });
            break;
          case 'request.body': {
            const item = pending.get(frame.requestId);
            if (!item) break;
            const chunk = Buffer.from(frame.body || '', 'base64');
            item.size += chunk.length;
            if (item.size > MAX_BODY) { pending.delete(frame.requestId); replyError(socket, frame.requestId, 413); }
            else item.chunks.push(chunk);
            break;
          }
          case 'request.end': {
            const item = pending.get(frame.requestId);
            if (!item) break;
            pending.delete(frame.requestId);
            const controller = new AbortController();
            active.add(controller);
            this.forward(socket, frame.requestId, item, controller.signal)
              .catch(() => replyError(socket, frame.requestId, 502))
              .finally(() => active.delete(controller));
            break;
          }
        }
      });
      socket.on('error', error => { if (!opened) reject(error); });
      socket.once('close', () => {
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', onAbort);
        for (const controller of active) controller.abort();
        if (opened) resolve(); else reject(new Error('relay connection closed'));
      });
    });
  }

  async forward(socket, id, item, signal) {
    const path = item.start.path;
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) { replyError(socket, id, 400); return; }
    const target = new URL(path, this.config.local);
    if (target.origin !== new URL(this.config.local).origin) { replyError(socket, id, 400); return; }
    const headers = copyHeaders(item.start.headers);
    if (this.config.localToken) headers.Authorization = `Bearer ${this.config.localToken}`;
    const body = Buffer.concat(item.chunks);
    let response;
    try {
      response = await fetch(target, { method: item.start.method, headers, redirect: 'manual', signal,
        body: body.length ? body : undefined });
      const payload = await limitedBody(response);
      const responseHeaders = {};
      for (const [key, value] of response.headers) {
        if (!blockedHeaders.has(key.toLowerCase())) responseHeaders[key] = [value];
      }
      send(socket, { type: 'response.start', requestId: id, status: response.status, headers: responseHeaders });
      sendBody(socket, 'response', id, payload);
    } catch (error) {
      if (error.message === 'response_too_large') replyError(socket, id, 502);
      else if (!signal.aborted) replyError(socket, id, 502);
    }
  }
}
