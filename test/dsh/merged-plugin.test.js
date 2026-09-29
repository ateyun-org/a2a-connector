import assert from 'node:assert/strict';
import { createServer as createTCPServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../../plugins/dsh/index.js';

test('one DSH plugin entry starts the bundled service after an occupied port', async t => {
  const occupied = createTCPServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const startPort = occupied.address().port;
  const state = join(await mkdtemp(join(tmpdir(), 'dsh-merged-a2a-')), 'state.json');
  let requested;
  const pairing = new Promise(resolve => { requested = resolve; });
  const relay = createHTTPServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pairing/requests') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requested(JSON.parse(raw));
      res.writeHead(201);
      res.end(JSON.stringify({ requestId: 'a'.repeat(64), agentId: 'integrated-dsh-agent',
        confirmationCode: 'ABC123', expiresAt: Math.floor(Date.now() / 1000) + 600 }));
    } else if (req.url === '/pairing/status') {
      res.end(JSON.stringify({ status: 'pending' }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const relayURL = `ws://127.0.0.1:${relay.address().port}/connect`;
  let effect, tool;
  const ctx = {
    effect(fn) { effect = fn; },
    tools: { register(value) { tool = value; } },
    agents: {}, agentDefaultModel: {}, sessions: {},
  };
  await apply(ctx, { relay: relayURL, allowInsecure: true,
    local: 'auto', port: startPort, portAttempts: 20,
    name: 'Integrated DSH Agent', state });
  assert.equal(typeof effect, 'function');
  assert.ok(tool, 'the same plugin registered its pairing tool');
  let adapterPort;
  for (let port = startPort + 1; port < Math.min(startPort + 20, 65536); port++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, {
        signal: AbortSignal.timeout(100), redirect: 'manual' });
      if (response.status === 401 && (await response.json()).error === 'unauthorized') {
        adapterPort = port; break;
      }
    } catch { /* another port did not answer */ }
  }
  assert.ok(adapterPort > startPort, 'the integrated service did not bind after the occupied port');
  const cleanup = effect();
  t.after(cleanup);
  let timer;
  const request = await Promise.race([pairing, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Connector could not discover its bundled A2A service')), 5000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(request.name, 'Integrated DSH Agent');
});

test('an explicitly configured DSH A2A origin skips the bundled service', async () => {
  let effect, tool;
  await apply({ effect(fn) { effect = fn; }, tools: { register(value) { tool = value; } } }, {
    relay: 'wss://relay.example/connect', local: 'http://127.0.0.1:9900', port: 0,
  });
  assert.equal(typeof effect, 'function');
  assert.ok(tool);
});

test('one DSH plugin entry registers inbound pairing and outbound A2A delegation', async () => {
  const providers = [], tools = [];
  await apply({ effect() {}, tools: { register(tool) { tools.push(tool.name); } },
    subagents: { registerProvider(provider) { providers.push(provider.name); } } }, {
    relay: 'wss://relay.example/connect', local: 'http://127.0.0.1:9900',
    agents: [{ id: 'reviewer', url: 'https://reviewer.example' }],
  });
  assert.deepEqual(providers, ['a2a:reviewer']);
  assert.deepEqual(tools, ['a2a_agents', 'a2a_send', 'a2a_task', 'a2a_cancel',
    'a2a_conversations', 'a2a_connector_pair']);
});
