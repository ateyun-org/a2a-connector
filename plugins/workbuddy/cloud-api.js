import { setTimeout as delay } from 'node:timers/promises';

export function cloudTaskId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid WorkBuddy cloud task ID');
  return id;
}

export function requireCloudScopes(scope) {
  const granted = new Set((scope || '').split(/\s+/));
  if (!['user.task.readable', 'user.task.invokable'].every(s => granted.has(s))) {
    throw new Error('WorkBuddy cloud permissions are missing; configure WORKBUDDY_SCOPES and authorize again');
  }
}

/** Open API credentials never go to a sandbox or a caller-selected origin. */
export class CloudAPI {
  constructor({ accessToken, fetchImpl = fetch, baseURL = 'https://www.workbuddy.cn/openapi/v2/', allowInsecure = false }) {
    const base = new URL(baseURL);
    const test = allowInsecure && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname);
    if ((!test && base.origin !== 'https://www.workbuddy.cn') || base.pathname !== '/openapi/v2/' ||
        base.username || base.password || base.search || base.hash) throw new Error('Invalid WorkBuddy API origin');
    if (typeof accessToken !== 'function') throw new Error('WorkBuddy token provider is required');
    Object.assign(this, { base, accessToken, fetch: fetchImpl });
  }

  async request(path, { body, signal } = {}) {
    if (typeof path !== 'string' || !/^tasks(?:\/[A-Za-z0-9_-]{1,128})?(?:\?page=\d+&size=\d+)?$/.test(path)) throw new Error('Invalid WorkBuddy cloud API route');
    const token = await this.accessToken();
    requireCloudScopes(token.scope);
    if (!token.accessToken) throw new Error('WorkBuddy is not authorized');
    let response;
    try {
      response = await this.fetch(new URL(path, this.base), { method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    } catch { throw new Error('WorkBuddy cloud API connection failed; creation must not be automatically repeated'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`WorkBuddy cloud API HTTP ${response.status}`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('WorkBuddy cloud response is too large');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw new Error('Invalid WorkBuddy cloud response'); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || 'code' in result) {
      throw new Error('Invalid WorkBuddy cloud API response shape');
    }
    return result;
  }

  async list({ page = 1, size = 100, signal } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error('Invalid task pagination');
    const data = await this.request(`tasks?page=${page}&size=${size}`, { signal });
    if (!Array.isArray(data.tasks) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Invalid WorkBuddy task list');
    for (const task of data.tasks) { cloudTaskId(task.task_id); if (typeof task.status !== 'string') throw new Error('Invalid cloud task status'); }
    return data;
  }

  async get(id, signal) {
    const data = await this.request(`tasks/${cloudTaskId(id)}`, { signal });
    if (data.task_id !== id || typeof data.status !== 'string') throw new Error('WorkBuddy returned a different cloud task');
    return data;
  }

  async create({ prompt, name }, signal) {
    const data = await this.request('tasks', { body: { prompt, name }, signal });
    cloudTaskId(data.task_id);
    return data;
  }

  async ready(id, { signal, timeoutMs = 120000, pollMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const task = await this.get(id, signal);
      if (['failed', 'archived', 'deleted'].includes(task.status)) throw new Error('Cloud session is unavailable');
      if (task.status === 'pending') throw new Error('Cloud session requires input in WorkBuddy before a new turn can start');
      // Never overlap the creation/bootstrap turn or another caller's active turn.
      if (task.link && task.token && ['idle', 'completed'].includes(task.status)) return task;
      if (Date.now() >= deadline) break;
      await delay(pollMs, undefined, { signal });
    } while (!signal?.aborted);
    throw new Error('Cloud session is not ready; inspect the existing cloud task before retrying');
  }
}
