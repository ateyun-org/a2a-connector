import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '../../plugins/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import AgentRegistry from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js';
import SessionStore from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import LlmRuntime, { createUserMessage, markAgentLoopRequest } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import SystemPrompt from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import SessionProjections from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import AgentLoop from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
import * as nativeExecutor from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js';
import * as persistence from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js';
import { RemoteAgentSessions } from '../../plugins/dsh/remote-sessions.js';
import { REMOTE_AGENT_PROVIDER, RemoteSessionAdapter } from '../../plugins/dsh/remote-session-adapter.js';

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

test('native transport rejects general model calls and does not advertise a model catalog', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { a2a, sends } = remote();
  const host = await nativeHost(root, a2a); t.after(() => host.close());
  assert.deepEqual(await host.adapter.listModels(), []);
  assert.equal(host.adapter.providerRetryPolicy().maxRetries, 0);
  await assert.rejects(async () => {
    for await (const _ of host.adapter.stream({ provider: REMOTE_AGENT_PROVIDER, model: 'one', sessionId: 'unbound', messages: [] })) {}
  }, /原生聊天/);
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
  const collect = async options => { const chunks = []; for await (const chunk of host.adapter.stream(options)) chunks.push(chunk); return chunks; };
  await assert.rejects(collect(options), /待确认/);
  assert.equal(sends.length, 1);
  const next = markAgentLoopRequest({ ...options, messages: [{ ...options.messages[0], id: 'another-message' }] });
  await assert.rejects(collect(next), /上一条请求/);
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
