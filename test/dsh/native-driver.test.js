import assert from 'node:assert/strict';
import test from 'node:test';
import { createDSHSessionFactory } from '../../plugins/dsh/dsh-session.js';

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
