import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlChats } from '../../plugins/dsh/control-service.js';

test('direct chat is durable, isolated by agent, deduplicated and recoverable without resending', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-chats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release, sends = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const result = { conversation: { id: 'conversation-1', state: 3, dispatchState: 'acknowledged' }, response: { parts: [{ text: 'remote answer' }] } };
  const a2a = { syncRelayTargets: async () => [{ agentId: 'one' }, { agentId: 'two' }],
    store: { list: async () => [] },
    send: async input => { sends++; assert.equal(input.parentId, 'a2a-control-owner-v1'); await gate; return result; },
    reconcile: async () => result };
  const path = join(directory, 'chat.json'), chats = new ControlChats(a2a, {}, path);
  const [first] = await Promise.all([chats.send({ agentId: 'one', text: 'hello', messageId: 'stable-1' }),
    chats.send({ agentId: 'one', text: 'hello', messageId: 'stable-1' })]);
  assert.equal(first.state, 'sending'); assert.equal(sends, 1);
  assert.equal((await chats.chat({ agentId: 'two' })).messages.length, 0);
  release(); await chats.jobs.get('one');
  const reloaded = new ControlChats(a2a, {}, path);
  const recovered = await reloaded.poll({ agentId: 'one' });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.messages.length, 2);
  assert.equal(recovered.messages[1].text, 'remote answer');
  await reloaded.send({ agentId: 'one', text: 'hello', messageId: 'stable-1' });
  assert.equal(sends, 1);
  await assert.rejects(reloaded.send({ agentId: 'one', text: 'changed', messageId: 'stable-1' }), /不同内容/);
  assert.equal(sends, 1);
});
