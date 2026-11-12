import { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL } from '../remote-route.js';

const storageKey = 'dsh.a2a.remote-agent';

/** Remote routing belongs to a native Session, never to the workspace or tab. */
export class RemoteSelection {
  constructor(ctx, remote, storage) {
    this.ctx = ctx; this.remote = remote;
    // Retire the old global default; persisted native bindings restore remote history.
    try { storage?.removeItem(storageKey); } catch {}
    this.snapshot = { agentId: null, sessionId: null, pending: false, resolving: false, error: '' };
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
    this.reconcile(true); this.patch({});
  }
  reconcile(discovered = false) {
    const row = this.currentSession(), id = row?.id;
    const route = row?.projectionValues?.modelSelection?.next;
    const bound = this.bindings.get(id);
    const overridden = bound && route &&
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
    if (!changed && this.snapshot.pending && !this.snapshot.resolving) return;
    // Keep an explicitly failed connection blocked until the user navigates or retries.
    if (!changed && !bound && this.snapshot.agentId && this.snapshot.error) {
      if (this.discovered && !this.targets.has(this.snapshot.agentId)) this.patch({
        error: '所选远程 Agent 已不可访问，请重新选择目标，或打开本地聊天。',
      });
      else this.updateBlock();
      return;
    }
    if (!id) { this.patch({ agentId: null, sessionId: null, pending: false, resolving: false, error: '' }); return; }
    if (bound) {
      if (this.discovered && !this.targets.has(bound)) {
        this.patch({ agentId: bound, sessionId: null, pending: false, resolving: false,
          error: '所选远程 Agent 已不可访问，请重新选择目标，或打开本地聊天。' });
      } else if (overridden) { void this.select(bound, { sessionId: id }); }
      else this.patch({ agentId: bound, sessionId: id, pending: false, resolving: false, error: '' });
      return;
    }
    if (route?.provider === REMOTE_AGENT_PROVIDER) {
      this.patch({ agentId: null, sessionId: null, pending: !this.discovered, resolving: true,
        error: this.discovered ? '此远程聊天的目标已不可访问，请打开本地聊天或重新选择 Agent。' : '' });
      return;
    }
    // Every unbound native history or blank is local, regardless of blank metadata.
    this.patch({ agentId: null, sessionId: null, pending: false, resolving: false, error: '' });
  }
  newChat(agentId = this.snapshot.agentId, sessionId) {
    if (!agentId) return;
    return this.select(agentId, { newSession: true, sessionId });
  }
  async archive(sessionId) {
    const agentId = this.bindings.get(sessionId), version = this.generation;
    const active = this.currentSession()?.id === sessionId && this.snapshot.agentId === agentId;
    await this.ctx.uiWorkspace.archiveSession(sessionId);
    if (!active || !agentId || !this.targets.has(agentId) || this.snapshot.pending) return false;
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
    const cancel = () => {
      if (version !== this.generation || !this.snapshot.pending) return;
      ++this.generation;
      this.patch({ agentId: null, sessionId: null, pending: false, resolving: false, error: '' });
      this.reconcile(true);
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.patch({ agentId, sessionId: null, pending: true, resolving: false, error: '' });
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
      signal.removeEventListener('abort', cancel);
      if (version === this.generation && this.snapshot.pending) this.patch({ pending: false });
    }
  }
  updateBlock() {
    if (!this.blockStore || !this.current) return;
    const value = this.blockStore.getSnapshot();
    const blocked = (this.snapshot.agentId || this.snapshot.resolving) &&
      (this.snapshot.pending || this.snapshot.resolving || this.snapshot.sessionId !== this.current);
    const reason = this.snapshot.error || (this.snapshot.resolving
      ? '正在读取当前聊天的远程 Agent，请稍候…' : '正在连接所选远程 Agent，请稍候…');
    if (blocked && !value) {
      this.ownBlock = { reason };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    } else if (!blocked && this.ownBlock && value === this.ownBlock) {
      this.ctx.conversation.blocks.set(this.current, undefined);
      this.ownBlock = undefined;
    } else if (blocked && value === this.ownBlock && value.reason !== reason) {
      this.ownBlock = { reason };
      this.ctx.conversation.blocks.set(this.current, this.ownBlock);
    }
  }
  releaseBlock() {
    this.stopBlock?.(); this.stopBlock = undefined;
    if (this.ownBlock && this.blockStore?.getSnapshot() === this.ownBlock) this.ctx.conversation.blocks.set(this.current, undefined);
    this.blockStore = undefined; this.ownBlock = undefined;
  }
}
