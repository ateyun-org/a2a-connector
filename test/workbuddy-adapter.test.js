import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge } from '../plugins/workbuddy/desktop-bridge.js';
import { TaskStore } from '../plugins/workbuddy/task-store.js';
import { createWorkBuddyAdapter, taskView } from '../plugins/workbuddy/adapter-server.js';

const message = (id = 'request-1', text = 'Create the requested report') => ({ messageId: id, role: 'ROLE_USER', parts: [{ text }] });
const response = (id, status = 'completed', text = 'Report created and verified') => ({
  message_id: `result-${id}`, role: 'assistant', msg_type: 'text', content: [JSON.stringify({ a2aTaskId: id, status, text })],
});
async function eventually(read, accept) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Expected task state did not arrive');
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-adapter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = [];
  const sent = [];
  const api = { status: async () => ({ online: true }),
    send: async prompt => { sent.push(prompt); return 'remote-1'; },
    messages: async () => history, ...overrides };
  const store = new TaskStore(join(directory, 'tasks.json'));
  const bridge = new DesktopBridge({ api, store, pollIntervalMs: 60000 });
  await bridge.start();
  t.after(() => bridge.close());
  return { bridge, store, api, history, sent };
}

test('the Hermes skill HTTP examples create, deduplicate and read an actual adapter task', async t => {
  const guide = await readFile(new URL('../plugins/hermes/skills/relay-calling/references/relay-http.md', import.meta.url), 'utf8');
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const send = examples.find(example => example.method === 'SendMessage');
  const get = examples.find(example => example.method === 'GetTask');
  assert.ok(send && get, 'the shipped skill must include executable send and read examples');
  const f = await fixture(t);
  const token = 'local-test-only-'.padEnd(32, 'x');
  const adapter = createWorkBuddyAdapter({ token, bridge: f.bridge });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const rpc = async body => {
    const response = await fetch(`http://127.0.0.1:${adapter.server.address().port}/rpc`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  send.params.message.messageId = randomUUID();
  send.params.message.parts[0].text = 'Verify skill request with "quotes" and\na newline';
  const created = await rpc(send);
  assert.equal(created.error, undefined);
  const taskID = created.result.task.id;
  assert.ok(taskID);
  await eventually(() => f.bridge.get(taskID), task => task.dispatchState === 'sent');
  assert.equal((await rpc(send)).result.task.id, taskID);
  assert.equal(f.sent.length, 1);
  get.params.id = taskID;
  assert.equal((await rpc(get)).result.id, taskID);
  const invalid = structuredClone(send);
  invalid.params.message.role = 'user';
  assert.equal((await rpc(invalid)).error.code, -32602);
  assert.equal(f.sent.length, 1, 'invalid wire role must not dispatch another task');
});

test('desktop adapter durably deduplicates sends and correlates only its final response', async t => {
  const f = await fixture(t);
  const [one, duplicate] = await Promise.all([f.bridge.submit(message()), f.bridge.submit(message())]);
  assert.equal(one.id, duplicate.id);
  await eventually(() => f.bridge.get(one.id), value => value.dispatchState === 'sent');
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.bridge.submit(message('request-1', 'changed')), /different task content/);
  await assert.rejects(f.bridge.submit(message('overlap')), /active or unresolved/);
  f.history.push({ message_id: 'unrelated', role: 'assistant', msg_type: 'text', content: ['All done'] });
  f.history.push(response('another-task'));
  await f.bridge.refresh(one.id);
  assert.equal((await f.bridge.get(one.id)).state, 'TASK_STATE_WORKING');
  f.history.push(response(one.id));
  await f.bridge.refresh(one.id);
  const done = await f.bridge.get(one.id);
  assert.equal(done.state, 'TASK_STATE_COMPLETED');
  assert.equal(taskView(done).artifacts[0].parts[0].text, 'Report created and verified');
  assert.equal(taskView(done).metadata.sharedDesktopConversation, true);
  const replay = await f.bridge.submit(message());
  assert.equal(replay.state, 'TASK_STATE_COMPLETED');
  assert.equal(f.sent.length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
});

test('restart resumes tracking a sent task without another dispatch', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  await f.bridge.close();
  f.history.push(response(task.id));
  const restarted = new DesktopBridge({ api: f.api, store: new TaskStore(f.store.path), pollIntervalMs: 60000 });
  t.after(() => restarted.close());
  await restarted.start();
  const done = await eventually(() => restarted.get(task.id), value => value.state === 'TASK_STATE_COMPLETED');
  assert.equal(done.remoteMessageId, 'remote-1');
  assert.equal(f.sent.length, 1);
});

test('uncertain send stays reserved and reconciles history without repeating execution', async t => {
  let posted;
  const f = await fixture(t, { send: async prompt => { posted = prompt; throw new Error('transport failed after acceptance'); } });
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'unknown');
  assert.equal((await f.bridge.submit(message())).id, task.id);
  await assert.rejects(f.bridge.submit(message('another')), /active or unresolved/);
  await f.bridge.close();
  f.history.push({ message_id: 'recovered-user', role: 'user', msg_type: 'text', content: [posted] }, response(task.id));
  const restarted = new DesktopBridge({ api: f.api, store: new TaskStore(f.store.path), pollIntervalMs: 60000 });
  t.after(() => restarted.close());
  await restarted.start();
  const done = await eventually(() => restarted.get(task.id), value => value.state === 'TASK_STATE_COMPLETED');
  assert.equal(done.remoteMessageId, 'recovered-user');
});

test('interrupted reservation is never automatically dispatched after restart', async t => {
  const f = await fixture(t);
  await f.store.transact(tasks => tasks.push({ id: 'interrupted', messageId: 'crash',
    contextId: 'ctx', prompt: 'must not resend', state: 'TASK_STATE_SUBMITTED',
    dispatchState: 'dispatching', updatedAt: new Date().toISOString() }));
  await f.bridge.close();
  const restarted = new DesktopBridge({ api: f.api, store: f.store, pollIntervalMs: 60000 });
  t.after(() => restarted.close());
  await restarted.start();
  await restarted.refresh('interrupted');
  assert.equal((await restarted.get('interrupted')).dispatchState, 'unknown');
  assert.equal(f.sent.length, 0);
});

test('approval is surfaced without approval bypass, and later completion can be tracked', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  f.history.push({ message_id: 'approval', role: 'assistant', msg_type: 'permission', content: ['Approval required'] });
  await f.bridge.refresh(task.id);
  assert.equal((await f.bridge.get(task.id)).state, 'TASK_STATE_INPUT_REQUIRED');
  assert.equal(f.sent.length, 1);
  f.history.push(response(task.id));
  f.history.push(response(task.id, 'input-required', 'an older question'));
  await f.bridge.refresh(task.id);
  assert.equal((await f.bridge.get(task.id)).state, 'TASK_STATE_COMPLETED');
});

test('desktop history supports typed text blocks and an empty message type', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  f.history.push({ message_id: 'typed-result', role: 'assistant', msg_type: '',
    content: [{ type: 'image', text: 'not a text block' }, { type: 'text', text: JSON.stringify({
      a2aTaskId: task.id, status: 'completed', text: 'verified desktop output' }) }] });
  await f.bridge.refresh(task.id);
  const done = await f.bridge.get(task.id);
  assert.equal(done.state, 'TASK_STATE_COMPLETED');
  assert.equal(done.output, 'verified desktop output');
  assert.equal(f.sent.length, 1);
});

test('live pre-execution channel rejection is surfaced after restart without resending', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  await f.bridge.close();
  const providerText = 'This channel is not configured. Please complete the setup in Claw Settings and try again.';
  f.history.push({ message_id: 'channel-setup', role: 'assistant', msg_type: '',
    content: [{ type: 'text', text: providerText }], metadata: { state: 'exec_approval' } });
  const resumed = new DesktopBridge({ api: f.api, store: f.store, pollIntervalMs: 60000 });
  t.after(() => resumed.close());
  await resumed.start();
  const blocked = await eventually(() => resumed.get(task.id), value => value.state === 'TASK_STATE_REJECTED');
  assert.match(blocked.output, /This channel is not configured/);
  assert.equal(taskView(blocked).metadata.providerState, 'exec_approval');
  assert.equal(taskView(blocked).metadata.blockedReason, 'workbuddy_channel_not_configured');
  assert.equal(f.sent.length, 1);
  assert.equal((await resumed.submit(message())).state, 'TASK_STATE_REJECTED');
  assert.equal(f.sent.length, 1);
});

test('metadata-only exec approval remains unresolved, then accepts a correlated final result', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  f.history.push({ message_id: 'tool-approval', role: 'assistant', msg_type: '',
    content: [{ type: 'text', text: 'Please approve this tool in WorkBuddy' }], metadata: { state: 'exec_approval' } });
  await f.bridge.refresh(task.id);
  assert.equal((await f.bridge.get(task.id)).state, 'TASK_STATE_INPUT_REQUIRED');
  await assert.rejects(f.bridge.submit(message('another')), /active or unresolved/);
  f.history.push(response(task.id));
  await f.bridge.refresh(task.id);
  const done = await f.bridge.get(task.id);
  assert.equal(done.state, 'TASK_STATE_COMPLETED');
  assert.equal(taskView(done).metadata.blockedReason, undefined);
  assert.equal(f.sent.length, 1);
});

test('localized channel rejection uses the same pre-execution failure state', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  f.history.push({ message_id: 'zh-rejection', role: 'assistant', msg_type: '',
    content: [{ type: 'text', text: '该通道尚未配置，请先在「Claw 设置」中完成配置后重试。' }],
    metadata: { state: 'exec_approval' } });
  await f.bridge.refresh(task.id);
  assert.equal((await f.bridge.get(task.id)).state, 'TASK_STATE_REJECTED');
});

test('polling does not fabricate progress or attribute a later user conversation approval', async t => {
  const f = await fixture(t);
  const task = await f.bridge.submit(message());
  const sent = await eventually(() => f.bridge.get(task.id), value => value.dispatchState === 'sent');
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.bridge.refresh(task.id);
  assert.equal((await f.bridge.get(task.id)).updatedAt, sent.updatedAt);
  // Newest-first provider history containing an unrelated user's turn.
  f.history.push({ message_id: 'other-approval', role: 'assistant', msg_type: '',
    content: [{ type: 'text', text: 'approve another task' }], metadata: { state: 'exec_approval' },
    created_at: '2026-10-20T21:26:41+08:00' });
  f.history.push({ message_id: 'other-user', role: 'user', msg_type: 'text', content: ['another task'],
    created_at: '2026-10-20T21:26:40+08:00' });
  await f.bridge.refresh(task.id);
  const unchanged = await f.bridge.get(task.id);
  assert.equal(unchanged.state, 'TASK_STATE_WORKING');
  assert.equal(unchanged.updatedAt, sent.updatedAt);
});

test('offline preflight fails without sending and history failure never reports completion', async t => {
  const f = await fixture(t, { status: async () => ({ online: false }) });
  const task = await f.bridge.submit(message());
  await eventually(() => f.bridge.get(task.id), value => value.state === 'TASK_STATE_FAILED');
  assert.equal(f.sent.length, 0);
  f.api.status = async () => ({ online: true });
  f.api.messages = async () => { throw new Error('read failed'); };
  const second = await f.bridge.submit(message('second'));
  await eventually(() => f.bridge.get(second.id), value => value.dispatchState === 'sent');
  await f.bridge.refresh(second.id);
  assert.equal((await f.bridge.get(second.id)).state, 'TASK_STATE_WORKING');
  assert.match((await f.bridge.get(second.id)).lastPollError, /unavailable/);
});

test('HTTP adapter authenticates requests, validates A2A, and advertises real text capability', async t => {
  const f = await fixture(t);
  const token = 'x'.repeat(64);
  const adapter = createWorkBuddyAdapter({ token, bridge: f.bridge });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const base = `http://127.0.0.1:${adapter.server.address().port}`;
  assert.equal((await fetch(base + '/.well-known/agent-card.json')).status, 401);
  assert.equal((await fetch(base + '/rpc', { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const card = await (await fetch(base + '/.well-known/agent-card.json', { headers })).json();
  assert.equal(card.supportedInterfaces[0].url, base + '/rpc');
  const rpc = async (method, params) => (await fetch(base + '/rpc', { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  assert.equal((await rpc('SendMessage', { message: { parts: [{ text: 'invalid' }] } })).error.code, -32602);
  const first = (await rpc('SendMessage', { message: message() })).result.task;
  assert.equal((await rpc('SendMessage', { message: message() })).result.task.id, first.id);
  assert.equal((await rpc('GetTask', { id: first.id })).result.id, first.id);
  assert.equal((await rpc('ListTasks', {})).result.tasks.length, 1);
  assert.equal((await rpc('CancelTask', { id: first.id })).error.code, -32002);
  assert.equal((await rpc('GetTask', { id: 'missing' })).error.code, -32001);
});
