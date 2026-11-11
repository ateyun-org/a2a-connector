import { randomUUID } from 'node:crypto';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConversationStore } from './store.js';
import { controlContract } from './control-contract.js';
import { REMOTE_AGENT_PROVIDER, RemoteSessionAdapter } from './remote-session-adapter.js';

/** A durable target-to-native-Session index. Transcript data stays in DSH. */
export class RemoteAgentSessions {
  constructor(ctx, a2a, path) {
    this.ctx = ctx; this.a2a = a2a; this.index = new ConversationStore(path); this.opening = new Map();
  }
  async targets() {
    const [targets, bindings] = await Promise.all([this.a2a.syncRelayTargets(), this.index.list()]);
    return targets.map(target => {
      const binding = bindings.find(item => item.agentId === target.agentId);
      return { ...target, ...(binding ? { sessionId: binding.sessionId } : {}) };
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
  open({ agentId }) {
    if (this.opening.has(agentId)) return this.opening.get(agentId);
    const operation = this.openNative(agentId).finally(() => this.opening.delete(agentId));
    this.opening.set(agentId, operation);
    return operation;
  }
  async openNative(agentId) {
    const target = await this.authorize(agentId);
    let binding = await this.index.get(agentId);
    if (!binding) {
      binding = { id: agentId, agentId, sessionId: `session-${randomUUID()}`, updatedAt: new Date().toISOString() };
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
          meta: { cwd: process.cwd() }, agentOptions: selection, setup });
        this.ctx.get('sessionTitle')?.rename(handle.agent.session, target.name || agentId);
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
