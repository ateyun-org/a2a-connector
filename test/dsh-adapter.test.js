import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdapterServer } from '../plugins/dsh/adapter-server.js';
import { createDSHSessionFactory } from '../plugins/dsh/adapter.js';

const token = 'x'.repeat(32);
async function fixture(t, createSession) {
  const adapter = createAdapterServer({ token, createSession });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const origin = `http://127.0.0.1:${adapter.server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const rpc = async (method, params) => (await fetch(`${origin}/rpc`, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const send = (text, contextId) => rpc('SendMessage', { message: { role: 'ROLE_USER', parts: [{ text }], contextId } });
  const settled = async id => {
    for (let i = 0; i < 100; i++) {
      const { result } = await rpc('GetTask', { id });
      if (result.status.state !== 'TASK_STATE_WORKING') return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Task did not settle');
  };
  return { origin, headers, rpc, send, settled };
}

test('adapter authenticates card/RPC and reuses native contexts, with isolated sessions', async t => {
  let created = 0, disposed = 0;
  const f = await fixture(t, async () => {
    created++;
    const history = [];
    return { run: async text => { history.push(text); return { text: history.join('|'), completed: true }; },
      cancel() {}, dispose() { disposed++; } };
  });
  assert.equal((await fetch(`${f.origin}/.well-known/agent-card.json`)).status, 401);
  assert.equal((await fetch(`${f.origin}/rpc`, { method: 'POST' })).status, 401);
  const card = await (await fetch(`${f.origin}/.well-known/agent-card.json`, { headers: f.headers })).json();
  assert.equal(card.supportedInterfaces[0].url, `${f.origin}/rpc`);
  const first = (await f.send('remember apple')).result.task;
  await f.settled(first.id);
  const second = (await f.send('recall', first.contextId)).result.task;
  assert.equal((await f.settled(second.id)).status.message.parts[0].text, 'remember apple|recall');
  const other = (await f.send('alone')).result.task;
  assert.equal((await f.settled(other.id)).status.message.parts[0].text, 'alone');
  assert.equal(created, 2);
  assert.ok((await f.send('bad', 'unknown')).error);
  assert.ok((await f.rpc('SendMessage', { message: { role: 'ROLE_USER', parts: [{ raw: 'bytes' }] } })).error);
  assert.equal((await f.rpc('ListTasks', { contextId: first.contextId })).result.tasks.length, 2);
  t.after(() => assert.equal(disposed, 2));
});

test('adapter rejects concurrent turns and cancellation cannot be overwritten by completion', async t => {
  let finish;
  const f = await fixture(t, async () => ({
    run: () => new Promise(resolve => { finish = resolve; }),
    cancel: () => finish({ text: 'late output', completed: true }), dispose() {},
  }));
  const task = (await f.send('slow')).result.task;
  assert.ok((await f.send('overlap', task.contextId)).error);
  assert.equal((await f.rpc('CancelTask', { id: task.id })).result.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await f.settled(task.id)).status.state, 'TASK_STATE_CANCELED');
});

test('native driver uses the same DSH session and flushes each turn', async () => {
  const events = [];
  const inputs = [];
  let creates = 0, flushes = 0, disposes = 0;
  const agent = {
    session: { get seq() { return events.length; }, eventAt: i => events[i] },
    whenIdle: async () => {},
    followup(message) {
      inputs.push(message);
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `turn ${inputs.length}` }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    }, cancel() {},
  };
  const create = createDSHSessionFactory({ agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async () => { creates++; return { agent, dispose: () => { disposes++; } }; } },
    sessions: { flush: async () => { flushes++; } } });
  const session = await create();
  assert.deepEqual(await session.run('one'), { text: 'turn 1', completed: true });
  assert.deepEqual(await session.run('two'), { text: 'turn 2', completed: true });
  await session.dispose();
  assert.equal(creates, 1); assert.equal(flushes, 2); assert.equal(disposes, 1);
});

test('cancelling during session creation prevents the queued prompt from running', async t => {
  let ready, runs = 0;
  const f = await fixture(t, () => new Promise(resolve => { ready = resolve; }));
  const task = (await f.send('must not execute')).result.task;
  await f.rpc('CancelTask', { id: task.id });
  ready({ run: async () => { runs++; return { completed: true, text: '' }; }, cancel() {}, dispose() {} });
  assert.equal((await f.settled(task.id)).status.state, 'TASK_STATE_CANCELED');
  assert.equal(runs, 0);
});
