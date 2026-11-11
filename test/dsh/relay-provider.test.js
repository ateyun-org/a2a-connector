import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient } from '../../plugins/dsh/relay-client.js';
import { installRelayProvider } from '../../plugins/dsh/provider.js';
import { A2AOrchestrator } from '../../plugins/dsh/orchestrator.js';

test('native DSH model adapter uses Relay catalog, rotates paired credentials and refuses unconfigured models', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-provider-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let enabled = true, adapter, base;
  let models = [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxTokens: 8192 }];
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url, auth: request.headers.authorization, body });
    if (request.url === '/relay/provider/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ enabled, apiKeyConfigured: true, models })); return;
    }
    assert.equal(request.url, '/relay/provider/anthropic/v1/messages');
    response.setHeader('Content-Type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant', type: 'message', model: 'deepseek-chat', content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const state = join(directory, 'dsh.json');
  const paired = token => writeFile(state, JSON.stringify({ agentId: 'controller', token, card: `${base}/agents/controller/.well-known/agent-card.json` }));
  await paired('agt_controller.first');
  const relay = new RelayClient({ relay: base, state, allowInsecure: true });
  installRelayProvider({ llm: { registerAdapter(routes, value) { assert.deepEqual(routes, ['a2a-relay']); adapter = value; } } }, relay, { resolveUserId: () => '00000000-0000-4000-8000-000000000001' });
  const listed = (await adapter.listModels('a2a-relay'))[0];
  assert.equal(listed.id, 'deepseek-chat');
  assert.equal(listed.name, 'DeepSeek Chat');
  assert.equal(listed.contextWindow, undefined);
  assert.equal(listed.maxTokens, undefined);
  const run = async model => {
    const chunks = [];
    for await (const chunk of adapter.stream({ provider: 'a2a-relay', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] })) chunks.push(chunk);
    return chunks;
  };
  const chunks = await run('deepseek-chat');
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'hello');
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert(requests.every(request => request.auth === 'Bearer agt_controller.first'));
  const sends = () => requests.filter(request => request.path.endsWith('/v1/messages'));
  assert.equal(sends().length, 1);
  await assert.rejects(run('not-enabled'), /未获/);
  assert.equal(sends().length, 1);
  await paired('agt_controller.rotated');
  await run('deepseek-chat');
  assert.equal(sends().at(-1).auth, 'Bearer agt_controller.rotated');
  models = [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }];
  const defaulted = (await adapter.listModels('a2a-relay'))[0];
  assert.equal(defaulted.contextWindow, undefined);
  assert.equal(defaulted.maxTokens, undefined);
  assert.equal((await run('deepseek-chat')).find(chunk => chunk.type === 'text-delta')?.text, 'hello');
  assert.equal(JSON.parse(sends().at(-1).body).max_tokens, JSON.parse(sends()[0].body).max_tokens, 'legacy Relay metadata changed the native adapter output default');
  enabled = false;
  await assert.rejects(run('deepseek-chat'), /启用/);
  assert.equal(sends().length, 3);
});

test('Relay inventory follows pagination and withdraws dynamically revoked targets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-targets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state.json'), origin = 'https://relay.example';
  await writeFile(state, JSON.stringify({ agentId: 'controller', token: 'agt_controller.fixture', card: `${origin}/agents/controller/.well-known/agent-card.json` }));
  let revoked = false;
  const a2a = new A2AOrchestrator({ relay: origin, state, connectorState: state, discoverRelayAgents: true, agents: [], storePath: join(directory, 'conversations.json') }, {
    fetchImpl: async input => {
      const page = Number(new URL(input).searchParams.get('page'));
      const id = page === 1 ? 'first' : 'second';
      return new Response(JSON.stringify({ targets: revoked ? [] : [{ agentId: id, name: id, online: true, busy: page === 1,
        card: `${origin}/agents/${id}/.well-known/agent-card.json` }], nextPage: !revoked && page === 1 ? 2 : 0 }));
    },
  });
  const targets = await a2a.syncRelayTargets();
  assert.equal(targets.length, 2); assert.equal(targets[0].busy, true);
  assert.deepEqual(a2a.configuredAgents().map(agent => agent.id), ['first', 'second']);
  revoked = true;
  await a2a.syncRelayTargets();
  assert.equal(a2a.configuredAgents().length, 0);
});
