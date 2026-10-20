import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudAPI } from '../plugins/workbuddy/cloud-api.js';
import { CloudBridge } from '../plugins/workbuddy/cloud-bridge.js';
import { TaskStore } from '../plugins/workbuddy/task-store.js';
import { ACPClient, acpURL, sseMessages } from '../plugins/workbuddy/acp-client.js';
import { createWorkBuddyAdapter, taskView } from '../plugins/workbuddy/adapter-server.js';
import { cloudProvider } from './helpers/workbuddy-cloud.js';

async function fixture(t, options = {}, taskId) {
  const provider = await cloudProvider(t, options);
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-cloud-'));
  const store = new TaskStore(join(directory, 'tasks.json'));
  const bridge = new CloudBridge({ ...provider, store, taskId, resultTimeoutMs: options.timeoutMs || 2000 });
  await bridge.start();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...provider, bridge, store };
}
const message = (messageId, contextId) => ({ role: 'ROLE_USER', messageId, ...(contextId ? { contextId } : {}), parts: [{ text: 'Write the report' }] });
async function wait(bridge, id, predicate) {
  for (let i = 0; i < 200; i++) {
    const task = await bridge.get(id);
    if (predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Cloud task did not reach expected state: ${JSON.stringify(await bridge.get(id))}`);
}
const completed = task => task.state === 'TASK_STATE_COMPLETED';

test('cloud creates a bootstrap session, executes once through ACP and returns live output/artifacts with no secret persistence', async t => {
  const f = await fixture(t);
  const initial = await f.bridge.submit(message('new-cloud'));
  const duplicate = await f.bridge.submit(message('new-cloud'));
  assert.equal(duplicate.id, initial.id);
  const task = await wait(f.bridge, initial.id, completed);
  assert.equal(f.creations.length, 1); assert.equal(f.prompts.length, 1);
  assert.match(f.creations[0].prompt, /wait for the next instruction/);
  assert.equal(f.prompts[0].params.prompt[0].text, 'Write the report');
  assert.equal(task.output, '云端实际结果');
  assert.equal(task.artifacts.length, 1); assert.equal(task.artifacts[0].text, 'verified artifact');
  assert.equal(taskView(task).metadata.sharedDesktopConversation, false);
  assert.equal(taskView(task).artifacts.length, 2);
  const journal = await readFile(f.store.path, 'utf8');
  assert.doesNotMatch(journal, /oauth-secret|acp-secret|connection-|OLD REPLAY|WRONG/);
  await assert.rejects(f.bridge.submit({ ...message('new-cloud'), parts: [{ text: 'different' }] }), /different task content/);
  const followup = await f.bridge.submit(message('followup', task.contextId));
  const result = await wait(f.bridge, followup.id, completed);
  assert.equal(result.remoteTaskId, task.remoteTaskId); assert.equal(f.creations.length, 1); assert.equal(f.prompts.length, 2);
});

test('cloud binds only the specified task, refreshes expired ACP credentials and never creates a substitute session', async t => {
  const f = await fixture(t, { expiredOnce: true }, 'existing');
  const task = await f.bridge.submit(message('bound'));
  const result = await wait(f.bridge, task.id, completed);
  assert.equal(result.remoteTaskId, 'existing'); assert.equal(result.sharedCloudSession, true);
  assert.equal(f.creations.length, 0); assert.equal(f.prompts.length, 1);
  assert.equal(f.calls.filter(call => call.method === 'session/load')[0].params.sessionId, 'existing');
});

test('cloud permission requires an explicit valid option and exposes no automatic approval', async t => {
  const f = await fixture(t, { permission: true }, 'existing');
  const task = await f.bridge.submit(message('permission'));
  const pending = await wait(f.bridge, task.id, value => !!value.permission);
  assert.equal(pending.state, 'TASK_STATE_INPUT_REQUIRED'); assert.equal(f.replies.length, 0);
  await assert.rejects(f.bridge.respondPermission(task.id, 'permission-1', 'invented'), /No matching/);
  const decisions = await Promise.allSettled([f.bridge.respondPermission(task.id, 'permission-1', 'allow'),
    f.bridge.respondPermission(task.id, 'permission-1', 'allow')]);
  assert.equal(decisions.filter(value => value.status === 'fulfilled').length, 1);
  await wait(f.bridge, task.id, completed);
  assert.deepEqual(f.replies[0].result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.equal(f.replies.length, 1);
  await assert.rejects(f.bridge.respondPermission(task.id, 'permission-1', 'allow'), /No matching/);
});

test('cloud cancellation answers pending permissions and waits for authoritative cancelled stopReason', async t => {
  const f = await fixture(t, { permission: true }, 'existing');
  const task = await f.bridge.submit(message('cancel'));
  await wait(f.bridge, task.id, value => !!value.permission);
  await f.bridge.cancel(task.id);
  const result = await wait(f.bridge, task.id, value => value.state === 'TASK_STATE_CANCELED');
  assert.equal(result.stopReason, 'cancelled');
  assert.deepEqual(f.replies[0].result, { outcome: { outcome: 'cancelled' } });
});

test('disconnection and restart preserve unresolved tasks without repeating creation or prompt', async t => {
  const f = await fixture(t, { disconnect: true });
  const initial = await f.bridge.submit(message('disconnect'));
  await wait(f.bridge, initial.id, value => value.dispatchState === 'unknown');
  await f.bridge.close();
  const restarted = new CloudBridge({ ...f, store: f.store });
  await restarted.start();
  t.after(() => restarted.close());
  assert.equal((await restarted.submit(message('disconnect'))).id, initial.id);
  await assert.rejects(restarted.submit(message('another')), /unresolved/);
  assert.equal(f.creations.length, 1); assert.equal(f.prompts.length, 1);
  assert.equal((await restarted.get(initial.id)).state, 'TASK_STATE_INPUT_REQUIRED');
});

test('uncertain creation is never retried and retains its unique lookup name', async t => {
  const f = await fixture(t, { uncertainCreate: true });
  const initial = await f.bridge.submit(message('create-timeout'));
  const result = await wait(f.bridge, initial.id, value => value.dispatchState === 'unknown');
  assert.equal(result.cloudName, `A2A-${initial.id}`); assert.equal(f.creations.length, 1); assert.equal(f.prompts.length, 0);
  await f.bridge.submit(message('create-timeout')); assert.equal(f.creations.length, 1);
});

test('prompt POST failure and response timeout never repeat a business instruction', async t => {
  for (const options of [{ rejectPrompt: true }, { hold: true, timeoutMs: 25 }]) {
    const messageId = `uncertain-${options.rejectPrompt ? 'post' : 'timeout'}`;
    const f = await fixture(t, options, 'existing');
    const task = await f.bridge.submit(message(messageId));
    await wait(f.bridge, task.id, value => value.dispatchState === 'unknown');
    assert.equal(f.prompts.length, 1); assert.equal(f.creations.length, 0);
    await f.bridge.submit(message(messageId));
    assert.equal(f.prompts.length, 1);
  }
});

test('explicit release checks provider inactivity, leaves unverified results rejected and frees the queue', async t => {
  const f = await fixture(t, { disconnect: true });
  const initial = await f.bridge.submit(message('release-unknown'));
  const unknown = await wait(f.bridge, initial.id, value => value.dispatchState === 'unknown');
  await assert.rejects(f.bridge.release(initial.id), /still active/);
  f.sessions.get(unknown.remoteTaskId).status = 'completed';
  const released = await f.bridge.release(initial.id);
  assert.equal(released.state, 'TASK_STATE_REJECTED'); assert.equal(released.trackingReleased, true);
  assert.match(released.output, /remains unverified/);
  const next = await f.bridge.submit(message('new-instruction'));
  assert.equal(next.state, 'TASK_STATE_SUBMITTED');
});

test('release of an uncertain creation requires the exact matching provider task name', async t => {
  const f = await fixture(t, { uncertainCreate: true });
  const initial = await f.bridge.submit(message('release-create'));
  const unknown = await wait(f.bridge, initial.id, value => value.dispatchState === 'unknown');
  await assert.rejects(f.bridge.release(initial.id, 'existing'), /name does not match/);
  f.sessions.get('existing').name = unknown.cloudName;
  const released = await f.bridge.release(initial.id, 'existing');
  assert.equal(released.remoteTaskId, 'existing'); assert.equal(released.state, 'TASK_STATE_REJECTED');
});

test('incomplete, refusal and unknown stop reasons never report successful completion', async t => {
  for (const [stopReason, expected] of [['max_tokens', 'TASK_STATE_INPUT_REQUIRED'], ['refusal', 'TASK_STATE_REJECTED'], ['future-reason', 'TASK_STATE_INPUT_REQUIRED']]) {
    const f = await fixture(t, { stopReason }, 'existing');
    const task = await f.bridge.submit(message(stopReason));
    const result = await wait(f.bridge, task.id, value => value.stopReason === stopReason);
    assert.equal(result.state, expected);
  }
});

test('unavailable bound session fails without falling back to creation', async t => {
  const f = await fixture(t, {}, 'does-not-exist');
  const task = await f.bridge.submit(message('missing'));
  await wait(f.bridge, task.id, value => value.state === 'TASK_STATE_FAILED');
  assert.equal(f.creations.length, 0); assert.equal(f.prompts.length, 0);
});

test('SSE handles fragmented UTF-8, CRLF, multiline data and comments and rejects unbounded events', async () => {
  const raw = Buffer.from(': heartbeat\r\ndata: {"jsonrpc":"2.0",\r\ndata: "result":{"text":"中文"}}\r\n\r\n');
  async function* bytes() { for (const byte of raw) yield Uint8Array.of(byte); }
  const messages = []; for await (const value of sseMessages(bytes())) messages.push(value);
  assert.equal(messages[0].result.text, '中文');
  async function* big() { yield Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 1)); }
  await assert.rejects(async () => { for await (const value of sseMessages(big())) void value; }, /too large/);
});

test('cloud API validates scopes, response shape, task identity and token destinations', async () => {
  const token = async () => ({ accessToken: 'secret', scope: 'user.task.readable user.task.invokable' });
  assert.throws(() => new CloudAPI({ accessToken: token, baseURL: 'https://evil.example/openapi/v2/' }), /origin/);
  for (const link of ['https://evil.example/acp', 'https://acp.workbuddy.cn.evil.example/sessions/a', 'https://acp.workbuddy.cn/sessions/a?token=x', 'http://127.0.0.1/acp']) assert.throws(() => acpURL(link), /Untrusted/);
  assert.equal(acpURL('https://65225-test.ap-guangzhou.agentos-run.net/acp').protocol, 'https:');
  let sends = 0;
  const missing = new CloudAPI({ accessToken: async () => ({ accessToken: 'secret', scope: 'user.task.readable' }), fetchImpl: async () => { sends++; } });
  await assert.rejects(missing.list(), /permissions/); assert.equal(sends, 0);
  const malformed = new CloudAPI({ accessToken: token, fetchImpl: async () => Response.json({ code: 0, data: {} }) });
  await assert.rejects(malformed.get('id'), /shape/);
  const wrong = new CloudAPI({ accessToken: token, fetchImpl: async () => Response.json({ task_id: 'other', status: 'idle' }) });
  await assert.rejects(wrong.get('id'), /different/);
  await assert.rejects(wrong.get('../id'), /Invalid/);
  await assert.rejects(wrong.request('https://evil.example/tasks'), /route/);
});

test('authenticated cloud adapter advertises cloud execution and exposes task/approval details', async t => {
  const f = await fixture(t, { permission: true }, 'existing');
  const adapter = createWorkBuddyAdapter({ bridge: f.bridge, token: 'private'.repeat(8), name: 'Cloud Worker' });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const base = `http://127.0.0.1:${adapter.server.address().port}`;
  const headers = { authorization: `Bearer ${'private'.repeat(8)}`, 'content-type': 'application/json' };
  const card = await (await fetch(base + '/.well-known/agent-card.json', { headers })).json();
  assert.equal(card.skills[0].id, 'workbuddy-cloud');
  const rpc = async (method, params) => (await (await fetch(base + '/rpc', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const sent = await rpc('SendMessage', { message: message('rpc-cloud') });
  const id = sent.result.task.id;
  await wait(f.bridge, id, value => !!value.permission);
  const queried = await rpc('GetTask', { id });
  assert.equal(queried.result.metadata.permission.requestId, 'permission-1');
  assert.equal((await rpc('RespondPermission', { id, requestId: 'permission-1', optionId: 'allow' })).error, undefined);
  await wait(f.bridge, id, completed);
});
