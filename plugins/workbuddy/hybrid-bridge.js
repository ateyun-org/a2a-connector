import { BridgeError } from './desktop-bridge.js';

/** One authorized WorkBuddy identity, with separate desktop/cloud execution queues. */
export class HybridBridge {
  constructor({ cloud, desktop, defaultMode = 'cloud' }) {
    if (!['cloud', 'desktop'].includes(defaultMode)) throw new Error('Invalid default execution mode');
    Object.assign(this, { cloud, desktop, defaultMode, mode: 'hybrid' });
    this.queue = Promise.resolve();
    this.store = { list: async () => [
      ...(await cloud.store.list()).map(task => ({ ...task, mode: 'cloud' })),
      ...(await desktop.store.list()).map(task => ({ ...task, mode: 'desktop' })),
    ] };
  }
  async start() {
    // Earlier single-mode switches could leave desktop records in the cloud journal.
    // Copy before removal so interruption cannot lose an existing task or cause a resend.
    const legacy = (await this.cloud.store.list()).filter(task => task.mode !== 'cloud');
    if (legacy.length) {
      await this.desktop.store.transact(tasks => {
        for (const task of legacy) {
          const prior = tasks.find(value => value.id === task.id || value.messageId === task.messageId);
          if (prior && (prior.id !== task.id || prior.messageId !== task.messageId || prior.fingerprint !== task.fingerprint)) {
            throw new Error('Conflicting legacy desktop task; inspect journals before migration');
          }
          if (!prior) tasks.push({ ...structuredClone(task), mode: 'desktop' });
        }
      });
      const migrated = new Set(legacy.map(task => task.id));
      await this.cloud.store.transact(tasks => {
        for (let i = tasks.length - 1; i >= 0; i--) if (migrated.has(tasks[i].id) && tasks[i].mode !== 'cloud') tasks.splice(i, 1);
      });
    }
    await Promise.all([this.cloud.start(), this.desktop.start()]);
  }
  submit(message) {
    const operation = this.queue.then(async () => {
      if (message?.metadata !== undefined && (!message.metadata || typeof message.metadata !== 'object' || Array.isArray(message.metadata))) {
        throw new BridgeError(-32602, 'Message metadata must be an object');
      }
      const explicit = message?.metadata?.workbuddyMode;
      if (explicit !== undefined && !['cloud', 'desktop'].includes(explicit)) throw new BridgeError(-32602, 'metadata.workbuddyMode must be cloud or desktop');
      const tasks = await this.store.list();
      const prior = tasks.find(task => task.messageId === message?.messageId);
      const context = message?.contextId && tasks.findLast(task => task.contextId === message.contextId);
      const mode = explicit || prior?.mode || context?.mode || this.defaultMode;
      if ((prior && prior.mode !== mode) || (context && context.mode !== mode)) throw new BridgeError(-32602, 'A messageId or contextId cannot change execution mode');
      return { ...await this[mode].submit(message), mode };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async target(id) {
    const task = (await this.store.list()).find(value => value.id === id);
    if (!task) throw new BridgeError(-32001, 'Task not found');
    return { bridge: this[task.mode], mode: task.mode };
  }
  async get(id) {
    const { bridge, mode } = await this.target(id);
    return { ...await bridge.get(id), mode };
  }
  async refreshTask(id) {
    const { bridge, mode } = await this.target(id);
    return { ...await (bridge.refreshTask ? bridge.refreshTask(id) : bridge.get(id)), mode };
  }
  async control(method, id, ...args) {
    const { bridge, mode } = await this.target(id);
    if (typeof bridge[method] !== 'function') throw new BridgeError(-32002, `Operation is unavailable in ${mode} mode`);
    return { ...await bridge[method](id, ...args), mode };
  }
  cancel(id) { return this.control('cancel', id); }
  respondPermission(id, requestId, optionId) { return this.control('respondPermission', id, requestId, optionId); }
  release(id, remoteId) { return this.control('release', id, remoteId); }
  resume(id) { return this.control('resume', id); }
  reconcile(id) { return this.control('reconcile', id); }
  async close() { await Promise.all([this.cloud.close(), this.desktop.close()]); }
}
