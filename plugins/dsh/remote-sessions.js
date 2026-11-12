import { randomUUID } from 'node:crypto';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConversationStore } from './store.js';
import { controlContract } from './control-contract.js';
import { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL, RemoteSessionAdapter } from './remote-session-adapter.js';

/** Durable native-Session target bindings. Transcript data stays in DSH. */
export class RemoteAgentSessions {
  constructor(ctx, a2a, path) {
    this.ctx = ctx; this.a2a = a2a; this.index = new ConversationStore(path); this.opening = new Map(); this.tail = Promise.resolve();
    this.known = new Map(); this.workspaceReady = new Set();
    this.ready = this.index.list().then(bindings => { for (const binding of bindings) this.known.set(binding.sessionId, binding); });
    // Native selectModel can replace a Session's route. Re-pin synchronously
    // before AgentLoop captures it, then reject any remaining mismatch.
    ctx.on('agent/inbox/claimed', ({ agent }) => {
      if (!this.known.has(agent.id)) return;
      const current = agent.model.current();
      if (current?.provider !== REMOTE_AGENT_PROVIDER || current.model !== REMOTE_AGENT_MODEL) {
        agent.model.select({ provider: REMOTE_AGENT_PROVIDER, model: REMOTE_AGENT_MODEL });
      }
    });
    ctx.on('agent/pre-step', async ({ agent, modelSelection }, next) => {
      await this.ready;
      if (this.known.has(agent.id) && (modelSelection.provider !== REMOTE_AGENT_PROVIDER || modelSelection.model !== REMOTE_AGENT_MODEL)) {
        throw new Error('此会话已绑定远程 Agent，请从左侧重新打开；消息不会改发给主控模型。');
      }
      return next();
    });
  }
  async targets() {
    const [targets, bindings] = await Promise.all([this.a2a.syncRelayTargets(), this.index.list()]);
    await this.ensureWorkspaces(bindings);
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
    await this.ready;
    return this.known.get(sessionId);
  }
  async saveBinding(binding) {
    await this.index.put(binding);
    this.known.set(binding.sessionId, binding);
  }
  userInput(sessionId, input) {
    const session = this.ctx.sessions.get(sessionId);
    if (!session) return undefined;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event.type !== 'user/message' || event.data.source?.kind !== 'user') continue;
      if (input.id) { if (event.data.id === input.id) return event.data; }
      // Some provider projections retain role/content only. Such a request must
      // exactly match the latest real user input; historical text is not enough.
      else return JSON.stringify(event.data.content) === JSON.stringify(input.content) ? event.data : undefined;
    }
  }
  open(input) {
    const key = input.newSession ? randomUUID() : JSON.stringify([input.agentId, input.sessionId ?? null]);
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
  async ensureWorkspaces(bindings, force = false) {
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry) return;
    const workspaces = new Map();
    for (const binding of bindings) {
      if (!binding.cwd || (!force && this.workspaceReady.has(binding.sessionId))) continue;
      if (!this.ctx.sessions.get(binding.sessionId) &&
        !await this.ctx.get('sessionPersistence')?.stat(binding.sessionId)) continue;
      if (!workspaces.has(binding.cwd)) {
        const workspace = await registry.resolveByPath(binding.cwd) || await registry.create?.(binding.cwd);
        workspaces.set(binding.cwd, workspace);
      }
      const workspace = workspaces.get(binding.cwd);
      if (!workspace) continue;
      if (!workspace.sessionIds?.includes(binding.sessionId)) await workspace.attachSession(binding.sessionId);
      this.workspaceReady.add(binding.sessionId);
    }
    for (const workspace of workspaces.values()) if (workspace) await this.prepareLocalBlank(workspace);
  }
  async prepareLocalBlank(workspace) {
    const controller = this.ctx.get('sessionController');
    if (!controller) return;
    const { items } = await controller.list({}, new AbortController().signal);
    const archived = this.ctx.workspaceRegistry.archivedSessionIds;
    const first = items.find(row => row.blank && !row.running && row.cwd === workspace.path &&
      workspace.sessionIds.includes(row.sessionId) && !archived.includes(row.sessionId));
    if (!first || !this.known.has(first.sessionId)) return;
    // Native New Session reuses the newest workspace blank. Keep that blank
    // local while the selected remote blank stays attached and editable.
    await new Promise(resolve => setTimeout(resolve, 1));
    await controller.create({ workspaceId: workspace.id });
  }
  async openNative({ agentId, sessionId, newSession = false }) {
    await this.ready;
    const target = await this.authorize(agentId);
    const bindings = await this.index.list();
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds || []);
    if (!newSession && sessionId && archived.has(sessionId)) throw new Error('此聊天已移至归档，请先在 DSH 中恢复。');
    const requested = sessionId ? await this.nativeAgent(sessionId) : undefined;
    const currentBinding = bindings.find(item => item.sessionId === sessionId);
    const cwd = requested?.session.header.cwd;
    let binding = !newSession && currentBinding?.agentId === agentId ? currentBinding : undefined;
    // The caller's Session provides cwd only. Keep native workspace blanks local.
    if (!newSession) binding ??= bindings.filter(item => item.agentId === agentId && !archived.has(item.sessionId) && (!requested || item.cwd === cwd))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!binding) {
      const id = `session-${randomUUID()}`;
      binding = { id: `native:${id}`, agentId, sessionId: id, cwd: cwd || process.cwd(), updatedAt: new Date().toISOString() };
      await this.saveBinding(binding);
    }
    const selection = { provider: REMOTE_AGENT_PROVIDER, model: REMOTE_AGENT_MODEL };
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
      }
      agent = handle.agent;
    }
    const current = agent.model.current();
    if (current?.provider !== selection.provider || current?.model !== selection.model) {
      if (agent.status === 'running') throw new Error('此会话正在执行，请结束当前请求后再切回远程 Agent。');
      agent.model.select(selection);
    }
    await this.ctx.sessions.flush(agent.session);
    await this.ensureWorkspaces([binding], true);
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
  return ctx.inject(['typert'], async scope => {
    const sessions = new RemoteAgentSessions(scope, a2a, path);
    await sessions.ready;
    scope.llm.registerAdapter([REMOTE_AGENT_PROVIDER], new RemoteSessionAdapter(sessions));
    new ControlService(scope, sessions);
    scope.effect(() => scope.typert.register({ package: controlContract.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: controlContract.descriptors }));
  });
}
