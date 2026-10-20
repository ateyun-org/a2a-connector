const scopes = ['user.localassistant.readable', 'user.localassistant.invokable'];
const limit = 4 * 1024 * 1024;

export function requireDesktopScopes(scope) {
  const granted = new Set((scope || '').split(/\s+/));
  if (!scopes.every(value => granted.has(value))) {
    throw new Error('WorkBuddy desktop permissions are missing; configure WORKBUDDY_SCOPES and authorize again');
  }
}

/** Fixed provider origin: neither task text nor a caller can choose a token destination. */
export class DesktopAPI {
  constructor({ accessToken, fetchImpl = fetch, baseURL = 'https://www.workbuddy.cn/openapi/v2/', allowInsecure = false }) {
    const base = new URL(baseURL);
    const testing = allowInsecure && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname);
    if ((!testing && base.origin !== 'https://www.workbuddy.cn') || base.pathname !== '/openapi/v2/' ||
        base.username || base.password || base.search || base.hash) throw new Error('Invalid WorkBuddy API origin');
    if (typeof accessToken !== 'function') throw new Error('WorkBuddy token provider is required');
    this.base = base;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
  }

  async request(path, { body, signal } = {}) {
    const value = await this.accessToken();
    requireDesktopScopes(value.scope);
    if (!value.accessToken) throw new Error('WorkBuddy is not authorized');
    let response;
    try {
      response = await this.fetch(new URL(path, this.base), {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { Authorization: `Bearer ${value.accessToken}`, Accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
    } catch { throw new Error('WorkBuddy API connection failed; do not automatically repeat a message send'); }
    if (!response.ok) throw new Error(`WorkBuddy API HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('WorkBuddy API response is too large');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw new Error('WorkBuddy API returned invalid JSON'); }
    if (result?.code !== 0 || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error('WorkBuddy API rejected the request or returned an invalid envelope');
    }
    return result.data;
  }

  async status(signal) {
    const value = await this.request('localassistant', { signal });
    if (typeof value.online !== 'boolean') throw new Error('WorkBuddy returned no desktop online status');
    return value;
  }

  async send(content, signal) {
    const value = await this.request('localassistant/message', { body: { content, msg_type: 'text' }, signal });
    if (typeof value.message_id !== 'string' || !value.message_id) throw new Error('WorkBuddy message outcome is unknown: no message ID');
    return value.message_id;
  }

  async messages({ after, offset = 0, signal } = {}) {
    const query = after ? `message_id=${encodeURIComponent(after)}` : `limit=100&offset=${offset}`;
    const value = await this.request(`localassistant/message?${query}`, { signal });
    if (!Array.isArray(value.messages) || value.messages.some(message =>
      !message || typeof message.message_id !== 'string' || !['user', 'assistant'].includes(message.role) ||
      !Array.isArray(message.content))) throw new Error('WorkBuddy returned invalid message history');
    return value.messages;
  }
}
