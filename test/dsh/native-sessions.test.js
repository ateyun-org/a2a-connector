import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '../../plugins/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import AgentRegistry from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js';
import SessionStore from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import LlmRuntime, { LlmAdapter, createUserMessage, markAgentLoopRequest, isAgentLoopRequest } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import SystemPrompt from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import SessionProjections from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import AgentLoop from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
import * as nativeExecutor from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js';
import * as persistence from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
import { RemoteAgentSessions } from '../../plugins/dsh/remote-sessions.js';
import { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL, RemoteSessionAdapter } from '../../plugins/dsh/remote-session-adapter.js';
import { SessionController } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js';
import { TypertRegistry } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js';
import { TypertGatewayService } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js';

async function nativeHost(root, a2a) {
  const ctx = new Context();
  const forks = [SessionStore, SessionProjections, AgentRegistry, LlmRuntime, SystemPrompt, ToolRuntime].map(plugin => ctx.plugin(plugin));
  await Promise.all(forks);
  const storage = ctx.plugin(persistence, { root: join(root, 'native'), compression: 'none' }); await storage;
  const executor = ctx.plugin(nativeExecutor); await executor;
  const loop = ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }); await loop;
  const sessions = new RemoteAgentSessions(ctx, a2a, join(root, 'bindings.json'));
  const adapter = new RemoteSessionAdapter(sessions);
  const registration = ctx.llm.registerAdapter([REMOTE_AGENT_PROVIDER], adapter);
  return { ctx, sessions, adapter, async close() {
    await loop.dispose(); registration(); await executor.dispose(); await storage.dispose();
    for (const fork of forks.reverse()) await fork.dispose();
  } };
}

function remote() {
  const records = [], sends = [], queries = [];
  const a2a = {
    targets: [{ agentId: 'one', name: '代码审查', online: true }, { agentId: 'two', name: '数据分析', online: true }],
    syncRelayTargets: async () => a2a.targets,
    store: { list: async parent => records.filter(record => record.parentId === parent) },
    async send(input) {
      sends.push(input);
      let record = records.find(record => record.id === input.conversationId);
      if (!record) { record = { id: `conversation-${records.length}`, parentId: input.parentId, agentId: input.agentId }; records.push(record); }
      Object.assign(record, { messageId: input.messageId, updatedAt: new Date().toISOString(), state: 3, dispatchState: 'acknowledged' });
      record.answer = `${input.agentId}: ${input.content.map(part => part.text).join('')}`;
      return { conversation: record, response: { answer: record.answer } };
    },
    async reconcile(id) { queries.push(id); const record = records.find(record => record.id === id); return { conversation: record, response: { answer: record.answer } }; },
    async waitForResult(_conversation, response) { return { output: [{ type: 'text', text: response.answer }], stopReason: 'stop' }; },
  };
  return { a2a, sends, queries };
}

function transcript(agent) {
  return Array.from({ length: agent.session.seq }, (_, seq) => agent.session.eventAt(seq));
}
async function prompt(agent, text) {
  const start = agent.session.seq;
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const events = transcript(agent).slice(start);
  const response = events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content;
  if (!response) assert.fail(JSON.stringify(events.filter(event => ['turn/end', 'assistant/attempt', 'request/end'].includes(event.type))));
  return response;
}

test('remote Agents use real native DSH loops, transcript persistence and isolated Sessions', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  let host = await nativeHost(root, a2a);
  t.after(() => host.close());
  const [one, same] = await Promise.all([host.sessions.open({ agentId: 'one' }), host.sessions.open({ agentId: 'one' })]);
  assert.equal(one.sessionId, same.sessionId); assert.equal(sends.length, 0);
  const first = host.ctx.agents.get(one.sessionId);
  assert.equal(first.model.current().provider, REMOTE_AGENT_PROVIDER);
  assert.deepEqual(await prompt(first, '检查代码'), [{ type: 'text', text: 'one: 检查代码' }]);
  assert.deepEqual(await prompt(first, '继续检查'), [{ type: 'text', text: 'one: 继续检查' }]);
  assert.equal(sends[1].conversationId, 'conversation-0');
  const two = await host.sessions.open({ agentId: 'two' });
  assert.notEqual(two.sessionId, one.sessionId);
  assert.deepEqual(await prompt(host.ctx.agents.get(two.sessionId), '分析数据'), [{ type: 'text', text: 'two: 分析数据' }]);
  assert.equal(sends[2].conversationId, undefined);
  assert.notEqual(sends[2].parentId, sends[0].parentId);
  assert.equal(transcript(first).filter(event => event.type === 'user/message').length, 2);
  await host.close();
  host = await nativeHost(root, a2a);
  const reopened = await host.sessions.open({ agentId: 'one' });
  assert.equal(reopened.sessionId, one.sessionId);
  const restored = host.ctx.agents.get(one.sessionId);
  assert.equal(transcript(restored).filter(event => event.type === 'assistant/message').length, 2);
  assert.equal(sends.length, 3, 'opening history dispatched remote work');
  assert.deepEqual(await prompt(restored, '重启后继续'), [{ type: 'text', text: 'one: 重启后继续' }]);
  assert.equal(sends.at(-1).conversationId, 'conversation-0');
  a2a.targets = a2a.targets.filter(target => target.agentId !== 'one');
  await assert.rejects(host.sessions.open({ agentId: 'one' }), /不可访问/);
  const before = sends.length;
  restored.followup(createUserMessage({ content: [{ type: 'text', text: '撤权后不得发送' }], source: { kind: 'user' } }));
  await restored.whenIdle();
  assert.equal(sends.length, before);
  assert.equal(transcript(restored).filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'error');
});

test('native transport advertises one display route while refusing auxiliary and unbound calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  assert.deepEqual(await host.adapter.listModels(), [{ provider: REMOTE_AGENT_PROVIDER, id: REMOTE_AGENT_MODEL, name: '远程 Agent 直聊', inputModalities: ['text'] }]);
  assert.equal(host.adapter.providerRetryPolicy().maxRetries, 0);
  await assert.rejects(async () => {
    for await (const _ of host.adapter.stream({ provider: REMOTE_AGENT_PROVIDER, model: 'one', sessionId: 'unbound', purpose: 'session-title', messages: [] })) {}
  }, /辅助模型/);
  await assert.rejects(async () => {
    for await (const _ of host.adapter.stream(markAgentLoopRequest({ provider: REMOTE_AGENT_PROVIDER,
      model: REMOTE_AGENT_MODEL, sessionId: 'unbound', messages: [] }))) {}
  }, /左侧/);
  const { sessionId } = await host.sessions.open({ agentId: 'one' });
  await assert.rejects(async () => {
    for await (const _ of host.adapter.stream({ provider: REMOTE_AGENT_PROVIDER, model: REMOTE_AGENT_MODEL, sessionId,
      messages: [{ ...createUserMessage({ content: [{ type: 'text', text: '未记录的输入' }], source: { kind: 'user' } }), role: 'user' }] })) {}
  }, /原生用户消息/);
  assert.equal(sends.length, 0);
});

test('native transport queries ambiguous messages instead of dispatching them again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends, queries } = remote();
  const send = a2a.send;
  a2a.send = async input => {
    const result = await send(input);
    result.conversation.dispatchState = 'unknown';
    return { ...result, response: undefined };
  };
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const { sessionId } = await host.sessions.open({ agentId: 'one' });
  const options = markAgentLoopRequest({ provider: REMOTE_AGENT_PROVIDER, model: 'one', sessionId,
    messages: [{ ...createUserMessage({ content: [{ type: 'text', text: '原请求' }], source: { kind: 'user' } }), role: 'user' }] });
  const agent = host.ctx.agents.get(sessionId);
  agent.followup(options.messages[0]); await agent.whenIdle();
  assert.equal(sends.length, 1);
  const collect = async options => { const chunks = []; for await (const chunk of host.adapter.stream(options)) chunks.push(chunk); return chunks; };
  const next = createUserMessage({ content: [{ type: 'text', text: '新的消息' }], source: { kind: 'user' } });
  agent.followup(next); await agent.whenIdle();
  assert.equal(sends.length, 1);
  const recovered = await collect(options);
  assert.equal(sends.length, 1);
  assert.deepEqual(queries, ['conversation-0']);
  assert(recovered.some(chunk => chunk.type === 'text-delta' && chunk.text === 'one: 原请求'));
});

test('native Stop aborts the remote wait without starting another request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  let began, aborted;
  const started = new Promise(resolve => { began = resolve; });
  a2a.waitForResult = (_conversation, _response, signal) => new Promise((resolve, reject) => {
    aborted = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    began();
  });
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const { sessionId } = await host.sessions.open({ agentId: 'one' });
  const agent = host.ctx.agents.get(sessionId);
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '执行任务' }], source: { kind: 'user' } }));
  await started;
  agent.cancel({ kind: 'user' }); await agent.whenIdle();
  assert(aborted.aborted);
  assert.equal(sends.length, 1);
  assert.equal(transcript(agent).filter(event => event.type === 'assistant/message').length, 0);
});

test('remote chats inherit cwd without adopting native workspace blanks and keep isolated history after restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  let host = await nativeHost(root, a2a); t.after(() => host.close());
  const createBlank = async (id, cwd) => (await host.ctx.agents.create({ sessionId: id,
    meta: { cwd }, agentOptions: { provider: 'local', model: 'default' } })).agent;
  const first = await createBlank('workspace-a', root);
  const a = await host.sessions.open({ agentId: 'one', sessionId: first.id });
  assert.notEqual(a.sessionId, first.id);
  assert.equal(first.model.current().provider, 'local');
  assert.equal(await host.sessions.binding(first.id), undefined);
  const remoteA = host.ctx.agents.get(a.sessionId);
  assert.equal(remoteA.session.header.cwd, root);
  assert.deepEqual(await prompt(remoteA, '项目 A'), [{ type: 'text', text: 'one: 项目 A' }]);
  const second = await createBlank('workspace-b', tmpdir());
  const b = await host.sessions.open({ agentId: 'one', sessionId: second.id });
  assert.notEqual(b.sessionId, second.id);
  assert.equal(second.model.current().provider, 'local');
  const remoteB = host.ctx.agents.get(b.sessionId);
  assert.equal(remoteB.session.header.cwd, tmpdir());
  assert.deepEqual(await prompt(remoteB, '项目 B'), [{ type: 'text', text: 'one: 项目 B' }]);
  const third = await createBlank('workspace-b-new', tmpdir());
  const c = await host.sessions.open({ agentId: 'one', sessionId: third.id, newSession: true });
  assert.notEqual(c.sessionId, third.id);
  assert.notEqual(c.sessionId, b.sessionId);
  assert.equal(third.model.current().provider, 'local');
  assert.deepEqual(await prompt(host.ctx.agents.get(c.sessionId), 'B 的新聊天'), [{ type: 'text', text: 'one: B 的新聊天' }]);
  assert.equal(sends[1].conversationId, undefined);
  assert.equal(sends[2].conversationId, undefined);
  assert.equal(new Set(sends.map(send => send.parentId)).size, 3);
  await host.close(); host = await nativeHost(root, a2a);
  const restored = await host.sessions.open({ agentId: 'one', sessionId: a.sessionId });
  assert.equal(restored.sessionId, a.sessionId);
  assert.equal(transcript(host.ctx.agents.get(a.sessionId)).filter(event => event.type === 'assistant/message').length, 1);
  assert.deepEqual(await prompt(host.ctx.agents.get(a.sessionId), '继续项目 A'), [{ type: 'text', text: 'one: 继续项目 A' }]);
  assert.equal(sends.at(-1).conversationId, 'conversation-0');
  assert.deepEqual(new Set((await host.sessions.targets())[0].sessionIds), new Set([a.sessionId, b.sessionId, c.sessionId]));
});

test('selecting a remote target preserves existing history and never reassigns another target Session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-target-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const attached = [];
  host.ctx.provide('workspaceRegistry', { async resolveByPath(cwd) {
    assert.equal(cwd, root);
    return { async attachSession(id) { attached.push(id); } };
  } });
  const local = (await host.ctx.agents.create({ sessionId: 'local-history', meta: { cwd: root },
    agentOptions: { provider: 'local', model: 'default' } })).agent;
  // A real native turn makes this a used Session even though the fixture has no local provider.
  local.followup(createUserMessage({ content: [{ type: 'text', text: '已有的本地记录' }], source: { kind: 'user' } }));
  await local.whenIdle();
  const seq = local.session.seq;
  const selected = await host.sessions.open({ agentId: 'one', sessionId: local.id });
  assert.notEqual(selected.sessionId, local.id);
  assert.equal(local.session.seq, seq);
  assert.equal(local.model.current().provider, 'local');
  assert.equal(await host.sessions.binding(local.id), undefined);
  assert.equal(host.ctx.agents.get(selected.sessionId).session.header.cwd, root);
  assert.deepEqual(attached, [], 'an empty remote chat occupied the native workspace reusable blank');
  await prompt(host.ctx.agents.get(selected.sessionId), '远程记录进入工作区历史');
  assert.deepEqual(attached, [selected.sessionId]);
  const other = await host.sessions.open({ agentId: 'two', sessionId: selected.sessionId });
  assert.notEqual(other.sessionId, selected.sessionId);
  assert.equal((await host.sessions.binding(selected.sessionId)).agentId, 'one');
  assert.equal((await host.sessions.binding(other.sessionId)).agentId, 'two');
  assert.equal((await host.sessions.open({ agentId: 'one', sessionId: other.sessionId })).sessionId, selected.sessionId);
  await assert.rejects(host.sessions.open({ agentId: 'one', sessionId: 'missing-session' }));
});

test('native SessionController model selection cannot send a bound chat to the controller model', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-model-picker-'));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a);
  // Real hosts may copy options in middleware or SDK message projection. This
  // deliberately drops the process-local WeakSet marker at the adapter boundary.
  const stream = host.adapter.stream.bind(host.adapter);
  let copies = 0;
  host.adapter.stream = options => {
    const copied = { ...options, messages: options.messages.map(({ source, id, ...message }) => ({ ...message })) };
    assert.equal(isAgentLoopRequest(copied), false); copies++;
    return stream(copied);
  };
  const forks = [];
  t.after(async () => { for (const fork of forks.reverse()) await fork.dispose(); await host.close(); await rm(root, { recursive: true, force: true }); });
  let localCalls = 0;
  class LocalModel extends LlmAdapter {
    providerInfo(id) { return { id, name: '主控测试模型' }; }
    async listModels(provider) { return [{ provider, id: 'local', name: '主控测试模型' }]; }
    async resolveModel(provider, id) { return { provider, id, name: '主控测试模型' }; }
    async *stream() {
      localCalls++;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '不应走到主控模型' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '不应走到主控模型' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const localRegistration = host.ctx.llm.registerAdapter(['controller-model'], new LocalModel());
  t.after(localRegistration);
  const ctx = host.ctx;
  let saved = { provider: 'controller-model', model: 'local' };
  ctx.provide('agentDefaultModel', { currentSelection: () => saved, async saveSelection(value) { saved = value; } });
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }), allows: () => true });
  ctx.provide('attachments', { admitPromptContent: async content => content, imageLimits: {
    maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 1024, mediaTypes: ['image/png'],
  } });
  ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) });
  ctx.provide('fs', {}); ctx.provide('sessionQuery', {});
  ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [], resolveByPath: async () => undefined });
  const registry = ctx.plugin(TypertRegistry); forks.push(registry); await registry;
  const gateway = ctx.plugin(TypertGatewayService, {}); forks.push(gateway); await gateway;
  const controller = ctx.plugin(SessionController, { nativeOpen: false }); forks.push(controller); await controller;
  const { sessionId } = await host.sessions.open({ agentId: 'one' });
  const agent = ctx.agents.get(sessionId);
  const catalog = await ctx.sessionController.modelCatalog();
  const group = catalog.groups.find(group => group.id === REMOTE_AGENT_PROVIDER);
  assert(group, JSON.stringify(catalog));
  assert(group.models.some(model => model.id === REMOTE_AGENT_MODEL && model.name === '远程 Agent 直聊'));
  // Exercise the same real Host methods used by the browser model picker and composer.
  await ctx.sessionController.selectModel({ sessionId, provider: 'controller-model', model: 'local' });
  assert.equal(agent.model.current().provider, 'controller-model', 'regression did not exercise an actual override');
  assert.equal(saved.provider, 'controller-model');
  await ctx.sessionController.prompt({ sessionId, requestId: 'browser-message-1', mode: 'queue',
    content: [{ type: 'text', text: '直接发送给远程目标' }] }, new AbortController().signal);
  await agent.whenIdle();
  assert.equal(localCalls, 0, 'browser model selection fell back to the controller LLM');
  assert.equal(copies, 1, 'request-copy regression was not exercised');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].agentId, 'one');
  assert.deepEqual(sends[0].content, [{ type: 'text', text: '直接发送给远程目标' }]);
  assert.equal(agent.model.current().provider, REMOTE_AGENT_PROVIDER);
  assert.equal(agent.model.current().model, REMOTE_AGENT_MODEL);
  assert.equal(saved.provider, 'controller-model', 'remote route changed the default for local DSH chats');
  assert.deepEqual(transcript(agent).filter(event => event.type === 'assistant/message').at(-1).data.message.content,
    [{ type: 'text', text: 'one: 直接发送给远程目标' }]);
  const local = await ctx.sessionController.create({ cwd: root });
  await ctx.sessionController.prompt({ sessionId: local.sessionId, requestId: 'browser-local-1', mode: 'queue',
    content: [{ type: 'text', text: '普通本地聊天' }] }, new AbortController().signal);
  await ctx.agents.get(local.sessionId).whenIdle();
  assert.equal(localCalls, 1, 'ordinary unbound DSH chats lost their selected model');
  assert.equal(sends.length, 1, 'ordinary local chat was redirected to a remote Agent');
  const workspaceBlank = await ctx.sessionController.create({ cwd: root });
  const remoteBlank = await host.sessions.open({ agentId: 'one', sessionId: workspaceBlank.sessionId, newSession: true });
  assert.notEqual(remoteBlank.sessionId, workspaceBlank.sessionId);
  const nativeNew = await ctx.sessionController.create({ cwd: root, sessionId: workspaceBlank.sessionId });
  assert.equal(nativeNew.sessionId, workspaceBlank.sessionId, 'native New Session did not exercise blank reuse');
  assert.equal(await host.sessions.binding(nativeNew.sessionId), undefined);
  await ctx.sessionController.prompt({ sessionId: nativeNew.sessionId, requestId: 'native-new-local', mode: 'queue',
    content: [{ type: 'text', text: '从远程切到原生新会话后发送' }] }, new AbortController().signal);
  await ctx.agents.get(nativeNew.sessionId).whenIdle();
  assert.equal(localCalls, 2, 'native New Session remained in remote mode');
  assert.equal(sends.length, 1, 'native New Session dispatched a remote message');
  await ctx.sessionController.prompt({ sessionId: local.sessionId, requestId: 'native-history-local', mode: 'queue',
    content: [{ type: 'text', text: '打开本地历史后继续' }] }, new AbortController().signal);
  await ctx.agents.get(local.sessionId).whenIdle();
  assert.equal(localCalls, 3);
  assert.equal(sends.length, 1, 'local history dispatched a remote message');
  await ctx.sessionController.prompt({ sessionId: remoteBlank.sessionId, requestId: 'remote-new-only', mode: 'queue',
    content: [{ type: 'text', text: '远程条目的新会话继续直聊' }] }, new AbortController().signal);
  await ctx.agents.get(remoteBlank.sessionId).whenIdle();
  assert.equal(localCalls, 3);
  assert.equal(sends.length, 2);
  assert.equal(sends.at(-1).agentId, 'one');
});

test('New Chat creates a fresh native Session and remote context, while history reopens the exact earlier chat', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-new-remote-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const first = await host.sessions.open({ agentId: 'one' });
  const firstAgent = host.ctx.agents.get(first.sessionId);
  await prompt(firstAgent, '第一段聊天');
  const seq = firstAgent.session.seq;
  const second = await host.sessions.open({ agentId: 'one', sessionId: first.sessionId, newSession: true });
  assert.notEqual(second.sessionId, first.sessionId);
  const secondAgent = host.ctx.agents.get(second.sessionId);
  assert.equal(secondAgent.session.header.cwd, firstAgent.session.header.cwd);
  assert.equal(transcript(secondAgent).filter(event => event.type === 'user/message').length, 0);
  await prompt(secondAgent, '新的一段聊天');
  assert.equal(sends[1].conversationId, undefined);
  assert.notEqual(sends[1].parentId, sends[0].parentId);
  assert.equal(firstAgent.session.seq, seq);
  const [third,fourth] = await Promise.all([
    host.sessions.open({ agentId: 'one', sessionId: second.sessionId, newSession: true }),
    host.sessions.open({ agentId: 'one', sessionId: second.sessionId, newSession: true }),
  ]);
  assert.notEqual(third.sessionId, fourth.sessionId, 'two explicit New Chat requests shared a Session');
  const reopened = await host.sessions.open({ agentId: 'one', sessionId: first.sessionId });
  assert.equal(reopened.sessionId, first.sessionId);
  await prompt(host.ctx.agents.get(reopened.sessionId), '继续第一段');
  assert.equal(sends.at(-1).conversationId, 'conversation-0');
  assert.equal((await host.sessions.targets())[0].sessionIds.length, 4);
});

test('archived remote chats are not reopened or recreated by target selection, and restoring preserves the original context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archived-remote-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const registry = { archivedSessionIds: [], resolveByPath: async () => undefined };
  host.ctx.provide('workspaceRegistry', registry);
  const first = await host.sessions.open({ agentId: 'one' });
  const firstAgent = host.ctx.agents.get(first.sessionId);
  await prompt(firstAgent, '保留待恢复的记录');
  const seq = firstAgent.session.seq;
  registry.archivedSessionIds.push(first.sessionId);
  await assert.rejects(host.sessions.open({ agentId: 'one', sessionId: first.sessionId }), /归档/);
  const second = await host.sessions.open({ agentId: 'one' });
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(firstAgent.session.seq, seq, 'archiving changed the original transcript');
  registry.archivedSessionIds.push(second.sessionId);
  const third = await host.sessions.open({ agentId: 'one' });
  assert(!registry.archivedSessionIds.includes(third.sessionId), 'target selection reopened an archived chat');
  assert.equal(sends.length, 1, 'archive/open dispatched a remote message');
  registry.archivedSessionIds = [second.sessionId];
  const restored = await host.sessions.open({ agentId: 'one', sessionId: first.sessionId });
  assert.equal(restored.sessionId, first.sessionId);
  await prompt(firstAgent, '恢复后继续');
  assert.equal(sends.at(-1).conversationId, 'conversation-0');
});

test('a fresh chat after archiving the last record keeps its workspace and sends through the remote native loop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-after-last-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  const registry = { archivedSessionIds: [], resolveByPath: async () => undefined };
  host.ctx.provide('workspaceRegistry', registry);
  const blank = (await host.ctx.agents.create({ sessionId: 'workspace-before-delete', meta: { cwd: root },
    agentOptions: { provider: 'local', model: 'default' } })).agent;
  const old = await host.sessions.open({ agentId: 'one', sessionId: blank.id });
  const oldAgent = host.ctx.agents.get(old.sessionId);
  await prompt(oldAgent, '将被归档的聊天');
  const oldSeq = oldAgent.session.seq;
  registry.archivedSessionIds.push(old.sessionId);
  const opened = await host.sessions.open({ agentId: 'one', sessionId: old.sessionId, newSession: true });
  assert.notEqual(opened.sessionId, old.sessionId);
  const fresh = host.ctx.agents.get(opened.sessionId);
  assert.equal(fresh.session.header.cwd, root);
  assert.equal(host.sessions.blank(fresh), true);
  assert.deepEqual(await prompt(fresh, '删光后继续聊天'), [{ type: 'text', text: 'one: 删光后继续聊天' }]);
  assert.equal(sends.length, 2);
  assert.equal(sends.at(-1).conversationId, undefined, 'fresh chat reused the archived remote context');
  assert.notEqual(sends.at(-1).parentId, sends[0].parentId);
  assert.equal(oldAgent.session.seq, oldSeq, 'sending in the fresh chat changed the archived history');
  assert.equal(blank.model.current().provider, 'local');
});

test('legacy empty remote workspace members stop being reusable native blanks, while local and used history remain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-workspace-blank-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a } = remote();
  let host = await nativeHost(root, a2a); t.after(() => host.close());
  let members = ['local-workspace-blank']; const detached = [];
  const workspace = { get sessionIds() { return members; },
    async attachSession(id) { if (!members.includes(id)) members.push(id); },
    async detachSession(id) { detached.push(id); members = members.filter(value => value !== id); } };
  const registry = { archivedSessionIds: [], resolveByPath: async () => workspace };
  host.ctx.provide('workspaceRegistry', registry);
  const local = (await host.ctx.agents.create({ sessionId: members[0], meta: { cwd: root },
    agentOptions: { provider: 'local', model: 'default' } })).agent;
  const blank = await host.sessions.open({ agentId: 'one', sessionId: local.id });
  assert(!members.includes(blank.sessionId));
  const used = await host.sessions.open({ agentId: 'two', sessionId: local.id });
  await prompt(host.ctx.agents.get(used.sessionId), '保留已有远程历史');
  assert(members.includes(used.sessionId));
  members.push(blank.sessionId); // Existing installs had attached remote blanks.
  await host.close(); host = await nativeHost(root, a2a);
  host.ctx.provide('workspaceRegistry', registry);
  await host.sessions.targets();
  assert.deepEqual(detached, [blank.sessionId]);
  assert.deepEqual(new Set(members), new Set([local.id, used.sessionId]));
  assert.equal(host.ctx.agents.get(blank.sessionId), undefined, 'cleanup resumed a cold remote Session');
  assert(await host.ctx.sessionPersistence.stat(blank.sessionId), 'cleanup removed the native transcript');
  await host.sessions.targets();
  assert.deepEqual(detached, [blank.sessionId], 'cleanup kept rewriting workspace membership');
});
