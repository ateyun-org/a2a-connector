import { randomUUID } from 'node:crypto';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConversationStore } from './store.js';
import { controlContract } from './control-contract.js';
import { REMOTE_AGENT_PROVIDER, RemoteSessionAdapter } from './remote-session-adapter.js';

/** Durable native-Session target bindings. Transcript data stays in DSH. */
export class RemoteAgentSessions {
  constructor(ctx, a2a, path) {
    this.ctx = ctx; this.a2a = a2a; this.index = new ConversationStore(path); this.opening = new Map(); this.tail = Promise.resolve();
  }
  async targets() {
    const [targets, bindings] = await Promise.all([this.a2a.syncRelayTargets(), this.index.list()]);
    return targets.map(target => {
      const owned = bindings.filter(item => item.agentId === target.agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { ...target, ...(owned.length ? { sessionId: owned[0].sessionId, sessionIds: owned.map(item => item.sessionId) } : {}) };
    });
  }
  async authorize(agentId, signal) {
    const target = (await this.a2a.syncRelayTargets({ signal })).find(item => item.agentId === agentId);
    if (!target) throw new Error('此远程 Agent 已不可访问，请刷新授权列表。');
    return target;
  }
  async binding(sessionId) {
    if (!sessionId) return undefined;
    return (await this.index.list()).find(item => item.sessionId === sessionId);
  }
  open(input) {
    const key = JSON.stringify([input.agentId, input.sessionId ?? null]);
    if (this.opening.has(key)) return this.opening.get(key);
    const operation = this.tail.then(() => this.openNative(input)).finally(() => this.opening.delete(key));
    this.tail = operation.catch(() => {});
    this.opening.set(key, operation);
    return operation;
  }
  async nativeAgent(sessionId) {
    const live = this.ctx.agents.get(sessionId);
    if (live) return live;
    if (!this.ctx.get('sessionPersistence')) throw new Error('原生会话已不可用，请重新选择工作区。');
    return (await this.ctx.agents.resume({ resumeSessionId: sessionId })).agent;
  }
  blank(agent) {
    if (agent.status !== 'idle') return false;
    for (let seq = 0; seq < agent.session.seq; seq++) {
      if (['turn/start', 'user/message'].includes(agent.session.eventAt(seq).type)) return false;
    }
    return true;
  }
  async openNative({ agentId, sessionId }) {
    const target = await this.authorize(agentId);
    const bindings = await this.index.list();
    const requested = sessionId ? await this.nativeAgent(sessionId) : undefined;
    const currentBinding = bindings.find(item => item.sessionId === sessionId);
    const cwd = requested?.session.header.cwd;
    let binding = currentBinding?.agentId === agentId ? currentBinding : undefined;
    // A workspace's unsent native Session can adopt the selected target. Never
    // reassign a Session that already belongs to another target or has history.
    if (!binding && requested && !currentBinding && this.blank(requested)) {
      return requested.runMaintenance(async () => {
        const adopted = { id: `native:${sessionId}`, agentId, sessionId, cwd, updatedAt: new Date().toISOString() };
        await this.index.put(adopted);
        requested.model.select({ provider: REMOTE_AGENT_PROVIDER, model: agentId });
        this.ctx.get('sessionTitle')?.rename(requested.session, target.name || agentId);
        await this.ctx.sessions.flush(requested.session);
        return { agentId, sessionId };
      });
    }
    binding ??= bindings.filter(item => item.agentId === agentId && (!requested || item.cwd === cwd))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!binding) {
      const id = `session-${randomUUID()}`;
      binding = { id: `native:${id}`, agentId, sessionId: id, cwd: cwd || process.cwd(), updatedAt: new Date().toISOString() };
      await this.index.put(binding);
    }
    const selection = { provider: REMOTE_AGENT_PROVIDER, model: agentId };
    let agent = this.ctx.agents.get(binding.sessionId);
    if (!agent) {
      const setup = (_agentCtx, value) => { value.model.select(selection); };
      let handle;
      if (this.ctx.get('sessionPersistence')) {
        try { handle = await this.ctx.agents.resume({ resumeSessionId: binding.sessionId, agentOptions: selection, setup }); }
        catch (error) { if (!(error instanceof SessionPersistenceNotFoundError)) throw error; }
      }
      if (!handle) {
        handle = await this.ctx.agents.create({ sessionId: binding.sessionId,
          meta: { cwd: binding.cwd || process.cwd() }, agentOptions: selection, setup });
        this.ctx.get('sessionTitle')?.rename(handle.agent.session, target.name || agentId);
        const registry = this.ctx.get('workspaceRegistry');
        if (registry) await (await registry.resolveByPath(handle.agent.session.header.cwd))?.attachSession(binding.sessionId);
      }
      agent = handle.agent;
    }
    const current = agent.model.current();
    if (current?.provider !== selection.provider || current?.model !== selection.model) {
      if (agent.status === 'running') throw new Error('此会话正在执行，请结束当前请求后再切回远程 Agent。');
      agent.model.select(selection);
    }
    await this.ctx.sessions.flush(agent.session);
    return { agentId, sessionId: agent.session.id };
  }
}

class ControlService extends TypertRemoteService {
  constructor(ctx, sessions) { super(ctx, 'a2aControl'); this.sessions = sessions; }
  owner() {
    if (this.ctx.invocation?.peer?.principal?.kind !== 'owner') throw new Error('仅 DSH 宿主所有者可使用远程 Agent 主控。');
  }
  targets() { this.owner(); return this.sessions.targets(); }
  open(input) { this.owner(); return this.sessions.open(input); }
}

export function installRemoteAgents(ctx, a2a, path) {
  return ctx.inject(['typert'], scope => {
    const sessions = new RemoteAgentSessions(scope, a2a, path);
    scope.llm.registerAdapter([REMOTE_AGENT_PROVIDER], new RemoteSessionAdapter(sessions));
    new ControlService(scope, sessions);
    scope.effect(() => scope.typert.register({ package: controlContract.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: controlContract.descriptors }));
  });
}
