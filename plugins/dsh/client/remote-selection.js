import { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL } from '../remote-route.js';

const storageKey = 'dsh.a2a.remote-agent';

/** The default target survives native workspace/blank-Session navigation.
 * Native history still owns its identity; no transcript or composer is replaced. */
export class RemoteSelection {
  constructor(ctx, remote, storage) {
    this.ctx = ctx; this.remote = remote; this.storage = storage;
    let agentId;
    try { agentId = storage?.getItem(storageKey) || null; } catch {}
    this.snapshot = { agentId: agentId || null, sessionId: null, pending: false, error: '' };
    this.listeners = new Set(); this.bindings = new Map(); this.generation = 0; this.current = undefined;
    this.targets = new Map();
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => this.snapshot;
  }
  patch(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.updateBlock();
    for (const listener of this.listeners) listener();
  }
  remember(agentId) {
    try { if (agentId) this.storage?.setItem(storageKey, agentId); else this.storage?.removeItem(storageKey); } catch {}
  }
  currentSession() {
    return Object.values(this.ctx.sessions.list.getSnapshot().byId).find(item => item.retainedBy?.mainView > 0);
  }
  start() {
    const stop = this.ctx.sessions.list.subscribe(() => this.reconcile());
    this.reconcile();
    return () => { ++this.generation; stop(); this.releaseBlock(); this.listeners.clear(); };
  }
  setTargets(targets) {
    this.discovered = true;
    this.targets = new Map(targets.map(target => [target.agentId, target]));
    for (const target of targets) {
      for (const id of target.sessionIds || (target.sessionId ? [target.sessionId] : [])) this.bindings.set(id, target.agentId);
    }
    if (this.snapshot.agentId && !targets.some(target => target.agentId === this.snapshot.agentId)) {
      ++this.generation;
      this.patch({ sessionId: null, pending: false, error: '所选远程 Agent 已不可访问，请重新选择目标，或从 DSH 历史记录打开本地聊天。' });
    } else { this.reconcile(true); this.patch({}); }
  }
  reconcile(discovered = false) {
    const row = this.currentSession(), id = row?.id;
    const route = row?.projectionValues?.modelSelection?.next;
    const overridden = this.snapshot.agentId && this.snapshot.sessionId === id && route &&
      (route.provider !== REMOTE_AGENT_PROVIDER || route.model !== REMOTE_AGENT_MODEL);
    if (id === this.current && !discovered && !overridden) return;
    const changed = id !== this.current;
    if (changed) {
      ++this.generation;
      this.releaseBlock(); this.current = id;
      if (id) {
        this.blockStore = this.ctx.conversation.blocks.storeFor(id);
        this.stopBlock = this.blockStore.subscribe(() => this.updateBlock());
      }
    }
    if (!id) { this.patch({ sessionId: null, pending: false }); return; }
    if (!changed && this.snapshot.pending) return;
    const bound = this.bindings.get(id);
    if (row.blank === false && !this.discovered) { this.updateBlock(); return; }
    if (bound && (!this.snapshot.agentId || (changed && row.blank === false))) {
      this.remember(bound);
      this.patch({ agentId: bound, sessionId: id, pending: false, error: '' });
      return;
    }
    // Explicitly opening local history keeps its local identity. Workspace and
    // New Session navigation produce blanks and inherit the default target.
    if (changed && row.blank === false && !bound) {
      this.remember(null);
      this.patch({ agentId: null, sessionId: null, pending: false, error: '' });
      return;
    }
    if (!this.snapshot.agentId) { this.updateBlock(); return; }
    if (this.snapshot.sessionId === id && bound === this.snapshot.agentId && !overridden) { this.updateBlock(); return; }
    void this.select(this.snapshot.agentId);
  }
  newChat(agentId = this.snapshot.agentId, sessionId) {
    if (!agentId) return;
    return this.select(agentId, { newSession: true, sessionId });
  }
  async archive(sessionId) {
    const agentId = this.bindings.get(sessionId), version = this.generation;
    const active = this.currentSession()?.id === sessionId && this.snapshot.agentId === agentId;
    await this.ctx.uiWorkspace.archiveSession(sessionId);
    if (!active || !agentId || this.snapshot.agentId !== agentId || this.snapshot.pending) return false;
    const current = this.currentSession()?.id;
    // Native archival clears mainView once. Any other navigation or selection
    // supersedes this continuation, including another pending New Chat.
    if ((current && current !== sessionId) || this.generation !== version + (current === sessionId ? 0 : 1)) return false;
    await this.newChat(agentId, sessionId);
    return true;
  }
  async select(agentId, options = {}) {
    const version = ++this.generation, current = options.sessionId || this.currentSession()?.id;
    // Native retention can briefly still expose an archived mainView. Use it
    // only for a fresh chat's cwd, never request that archived transcript again.
    const newSession = options.newSession || (!options.sessionId &&
      this.ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(current));
    const signal = this.ctx.layout.beginNavigation();
    this.remember(agentId);
    this.patch({ agentId, sessionId: null, pending: true, error: '' });
    try {
      const result = await this.remote.open({ agentId, ...(current ? { sessionId: current } : {}), ...(newSession ? { newSession: true } : {}) });
      if (!result.ok) throw new Error(result.error?.message || '远程会话连接失败，请重试。');
      if (version !== this.generation || signal.aborted) return;
      const opened = result.value;
      this.bindings.set(opened.sessionId, agentId);
      await this.ctx.sessions.refresh();
      if (version !== this.generation || signal.aborted) return;
      this.patch({ sessionId: opened.sessionId, pending: false });
      this.ctx.uiWorkspace.openSession(opened.sessionId);
    } catch (error) {
      if (version === this.generation) this.patch({ pending: false, error: error.message });
    } finally {
      if (version === this.generation && this.snapshot.pending) this.patch({ pending: false });
    }
  }
  updateBlock() {
    if (!this.blockStore || !this.current) return;
    const value = this.blockStore.getSnapshot();
    const blocked = this.snapshot.agentId && (this.snapshot.pending || this.snapshot.sessionId !== this.current);
    if (blocked && !value) {
      this.ownBlock = { reason: this.snapshot.error || '正在连接所选远程 Agent，请稍候…' };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    } else if (!blocked && this.ownBlock && value === this.ownBlock) {
      this.ctx.conversation.blocks.set(this.current, undefined);
      this.ownBlock = undefined;
    } else if (blocked && value === this.ownBlock && value.reason !== (this.snapshot.error || '正在连接所选远程 Agent，请稍候…')) {
      this.ownBlock = { reason: this.snapshot.error || '正在连接所选远程 Agent，请稍候…' };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    }
  }
  releaseBlock() {
    this.stopBlock?.(); this.stopBlock = undefined;
    if (this.ownBlock && this.blockStore?.getSnapshot() === this.ownBlock) this.ctx.conversation.blocks.set(this.current, undefined);
    this.blockStore = undefined; this.ownBlock = undefined;
  }
}
