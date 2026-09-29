import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { callAgent, getAgentTask } from '../plugins/workbuddy/a2a-client.js';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `ws://127.0.0.1:${server.address().port}/connect`;
}

const enrollment = { agentId: 'workbuddy', token: 'agt_workbuddy.secret' };

test('WorkBuddy can call an authorized Relay target and poll its task', async t => {
  let polls = 0;
  const relay = await fixture(t, async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${enrollment.token}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/agents/reviewer/.well-known/agent-card.json') {
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC',
        url: `http://127.0.0.1:${req.socket.localPort}/agents/reviewer/rpc` }] }));
      return;
    }
    assert.equal(req.url, '/agents/reviewer/rpc');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.method === 'SendMessage') {
      assert.equal(body.params.message.parts[0].text, 'review this');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: {
        id: 'task-1', contextId: 'context-1', status: { state: 'TASK_STATE_WORKING' } } } }));
      return;
    }
    assert.equal(body.method, 'GetTask');
    assert.equal(body.params.id, 'task-1');
    polls++;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { id: 'task-1', contextId: 'context-1',
      status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'review complete' }] } } } }));
  });
  const result = await callAgent({ relay, allowInsecure: true, enrollment, targetId: 'reviewer',
    prompt: 'review this', pollIntervalMs: 1 });
  assert.deepEqual(result, { targetId: 'reviewer', taskId: 'task-1', contextId: 'context-1',
    state: 'TASK_STATE_COMPLETED', text: 'review complete' });
  assert.equal(polls, 1);
  assert.equal((await getAgentTask({ relay, allowInsecure: true, enrollment,
    targetId: 'reviewer' }, 'task-1')).text, 'review complete');
  assert.equal(polls, 2);
});

test('WorkBuddy call requires grant and never sends token to a card supplied external URL', async t => {
  let forwarded = 0;
  const relay = await fixture(t, (req, res) => {
    if (req.url.endsWith('/agent-card.json')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC',
        url: 'https://attacker.example/rpc' }] }));
    } else { forwarded++; res.writeHead(404); res.end(); }
  });
  await assert.rejects(callAgent({ relay, allowInsecure: true, enrollment,
    targetId: 'reviewer', prompt: 'private task' }), /no JSONRPC endpoint under this Relay target/);
  assert.equal(forwarded, 0);

  const denied = await fixture(t, (_req, res) => { res.writeHead(403); res.end(); });
  await assert.rejects(callAgent({ relay: denied, allowInsecure: true, enrollment,
    targetId: 'reviewer', prompt: 'task' }), /grant this Agent access/);
  await assert.rejects(callAgent({ relay, allowInsecure: true, enrollment,
    targetId: '../admin', prompt: 'task' }), /invalid target Agent ID/);
});
