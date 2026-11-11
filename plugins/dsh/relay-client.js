import { readFile } from 'node:fs/promises';

/** Pairing credentials stay on the Host and are re-read for rotation. */
export class RelayClient {
  constructor(config, { fetchImpl = fetch } = {}) {
    const relay = new URL(config.relay);
    if (relay.protocol === 'wss:') relay.protocol = 'https:';
    if (relay.protocol === 'ws:') relay.protocol = 'http:';
    if (relay.username || relay.password || !['https:', 'http:'].includes(relay.protocol) ||
        (relay.protocol === 'http:' && !config.allowInsecure)) throw new Error('Relay requires HTTPS');
    this.origin = relay.origin;
    this.statePath = config.connectorState || config.state;
    this.fetchImpl = fetchImpl;
  }

  async credential() {
    let state;
    try { state = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch { throw new Error('请先完成 DSH Connector 配对，再刷新主控页面。'); }
    if (new URL(state.card).origin !== this.origin || !state.agentId ||
        typeof state.token !== 'string' || !state.token.startsWith(`agt_${state.agentId}.`)) {
      throw new Error('DSH 配对身份与当前 Relay 不匹配。');
    }
    return state.token;
  }

  async request(path, { signal, ...init } = {}) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Relay origin mismatch');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.credential()}`);
    const timeout = AbortSignal.timeout(15000);
    const response = await this.fetchImpl(url, { ...init, headers, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 401 ? 'DSH 配对凭据已失效，请重新接入。'
        : response.status === 403 ? '当前 DSH 无权访问此功能，请检查主控能力和授权。' : 'Relay 暂时不可用，请稍后刷新。');
    }
    return response.json();
  }

  async targets({ signal } = {}) {
    const targets = [];
    let page = 1;
    do {
      const value = await this.request(`/pairing/targets?page=${page}&pageSize=100`, { signal });
      if (!Array.isArray(value.targets) || !Number.isInteger(value.nextPage) || value.nextPage < 0 ||
          (value.nextPage !== 0 && value.nextPage !== page + 1)) throw new Error('Relay 返回了无效的 Agent 列表。');
      for (const target of value.targets) {
        if (typeof target.agentId !== 'string' || new URL(target.card).origin !== this.origin ||
            new URL(target.card).pathname !== `/agents/${target.agentId}/.well-known/agent-card.json`) {
          throw new Error('Relay 返回了无效的 Agent 卡片。');
        }
        targets.push(target);
      }
      page = value.nextPage;
      if (page > 10000) throw new Error('Relay Agent 列表超出范围。');
    } while (page);
    return targets;
  }

  async models({ signal } = {}) {
    const value = await this.request('/relay/provider/models', { signal });
    if (!Array.isArray(value.models) || typeof value.enabled !== 'boolean') throw new Error('Relay 模型列表无效。');
    return value;
  }
}
