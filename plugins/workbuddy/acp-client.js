export function acpURL(link, allowInsecure = false) {
  const url = new URL(link);
  const provider = url.protocol === 'https:' && !url.port &&
    ((url.hostname === 'acp.workbuddy.cn' && /^\/sessions\/[A-Za-z0-9_-]+$/.test(url.pathname)) ||
      (url.hostname.endsWith('.agentos-run.net') && url.pathname === '/acp') ||
      // Current WorkBuddy Open API also issues Cloud Studio E2B sandbox links.
      (/^65225-[a-f0-9]{32}\.e2b\.[a-z0-9-]+\.sandbox\.cloudstudio\.club$/.test(url.hostname) && url.pathname === '/acp'));
  const test = allowInsecure && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!provider && !test) || url.username || url.password || url.search || url.hash) throw new Error('Untrusted WorkBuddy ACP address');
  return url;
}

/** SSE parser preserves UTF-8 and multi-line data across arbitrary transport chunks. */
export async function* sseMessages(body) {
  const decoder = new TextDecoder();
  let buffer = '', data = [], eventBytes = 0;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error('ACP event line too large');
    let match;
    while ((match = /\r\n|\r(?!$)|\n/.exec(buffer))) {
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (data.length) {
          let message;
          try { message = JSON.parse(data.join('\n')); } catch { throw new Error('Invalid ACP event'); }
          yield message;
        }
        data = []; eventBytes = 0;
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        eventBytes += Buffer.byteLength(value);
        if (eventBytes > 1024 * 1024) throw new Error('ACP event too large');
        data.push(value);
      }
    }
  }
  // An unterminated final event is not proof that a turn completed.
}

export class ACPClient {
  constructor({ fetchImpl = fetch, allowInsecure = false, signal, onEvent = async () => {} } = {}) {
    Object.assign(this, { fetch: fetchImpl, allowInsecure, signal, onEvent });
    this.controller = new AbortController();
    this.pending = new Map();
    this.nextRequestId = 1;
  }

  async connect({ link, token }) {
    this.url = acpURL(link, this.allowInsecure);
    if (typeof token !== 'string' || !token) throw new Error('Cloud ACP credentials are not ready');
    this.token = token;
    const timer = setTimeout(() => this.controller.abort(), 15000);
    let response;
    try {
      response = await this.fetch(this.url, { redirect: 'manual', headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: this.signal ? AbortSignal.any([this.signal, this.controller.signal]) : this.controller.signal });
    } catch { throw new Error('WorkBuddy ACP connection failed'); }
    finally { clearTimeout(timer); }
    this.connectionId = response.headers.get('Acp-Connection-Id');
    if (!response.ok || !this.connectionId || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      const error = new Error(`WorkBuddy ACP connection HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    this.pump = (async () => {
      try {
        for await (const message of sseMessages(response.body)) {
          // The live gateway emits notifications with jsonrpc:"" during load.
          // Only known notifications may omit the version; responses stay strict.
          const providerNotification = message?.id === undefined &&
            ['', undefined].includes(message?.jsonrpc) && typeof message?.method === 'string' &&
            (message.method === 'session/update' || message.method.startsWith('_codebuddy.ai/'));
          if (message?.jsonrpc !== '2.0' && !providerNotification) throw new Error('Invalid ACP RPC envelope');
          if (!message.method && this.pending.has(message.id)) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error('WorkBuddy ACP request failed'));
            else if (!message.result || typeof message.result !== 'object') entry.reject(new Error('Invalid ACP response'));
            else entry.resolve(message.result);
          } else if (message.method) await this.onEvent(message);
        }
      } catch { /* Never expose upstream response bodies or credential-bearing URLs. */ }
      finally {
        this.closed = true;
        for (const pending of this.pending.values()) pending.reject(new Error('WorkBuddy ACP disconnected; task outcome requires verification'));
        this.pending.clear();
      }
    })();
  }

  async send(message) {
    if (this.closed || !this.connectionId) throw new Error('WorkBuddy ACP is not connected');
    let response;
    try {
      response = await this.fetch(this.url, { method: 'POST', redirect: 'manual',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', 'Acp-Connection-Id': this.connectionId },
        body: JSON.stringify(message), signal: AbortSignal.any([this.controller.signal,
          ...(this.signal ? [this.signal] : []), AbortSignal.timeout(15000)]) });
    } catch { throw new Error('WorkBuddy ACP send outcome is unknown; do not repeat the prompt'); }
    await response.body?.cancel();
    if (!response.ok) {
      const error = new Error(`WorkBuddy ACP POST HTTP ${response.status}; do not repeat the prompt`);
      error.status = response.status;
      throw error;
    }
  }

  allocateRequestId() { return this.nextRequestId++; }

  resolveNotificationResponse(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(result);
    return true;
  }

  async request(method, params, { id = this.allocateRequestId(), timeoutMs = 30000 } = {}) {
    let entry;
    const result = new Promise((resolve, reject) => { entry = { resolve, reject }; });
    result.catch(() => {});
    if (this.pending.has(id)) throw new Error('Duplicate ACP request ID');
    this.pending.set(id, entry);
    const timer = setTimeout(() => entry.reject(new Error('ACP response timed out; do not repeat the prompt')), timeoutMs);
    try {
      await this.send({ jsonrpc: '2.0', id, method, params });
      return await result;
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  async load(sessionId, cwd = '/workspace') {
    const initialized = await this.request('initialize', { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    await this.request('session/load', { sessionId, cwd, mcpServers: [] });
  }

  async close() { this.controller.abort(); await this.pump; this.token = undefined; }
}
