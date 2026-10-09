import assert from 'node:assert/strict';
import { createServer as createTCPServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../../plugins/dsh/index.js';
import { WebSocketServer } from 'ws';

async function waitStatus(tool, check) {
  const deadline = Date.now() + 8000;
  let value;
  while (Date.now() < deadline) {
    value = JSON.parse((await tool.execute({})).text);
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`DSH Connector did not recover its tunnel: ${JSON.stringify(value)}`);
}

test('DSH recovers a stale lock, restarts a killed Connector, and clears logs from the previous run', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'dsh.json');
  const credentials = JSON.stringify({ agentId: 'dsh-recovery', token: 'agt_dsh-recovery.secret' });
  await writeFile(state, credentials, { mode: 0o600 });
  await mkdir(state + '.lock');
  await writeFile(state + '.lock/owner.json', JSON.stringify({
    pid: process.pid, hostname: hostname(), instanceId: 'old-run', processIdentity: 'previous-boot',
  }));
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  t.after(() => { for (const socket of relay.clients) socket.terminate(); relay.close(); });
  const local = createHTTPServer((_req, res) => res.end(JSON.stringify({ name: 'DSH Recovery' })));
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());
  let effect;
  const tools = new Map();
  await apply({ effect(fn) { effect = fn; }, tools: { register(tool) { tools.set(tool.name, tool); } } }, {
    relay: `ws://127.0.0.1:${relay.address().port}/connect`, allowInsecure: true,
    local: `http://127.0.0.1:${local.address().port}`, state,
  });
  const cleanup = effect();
  t.after(cleanup);
  const tool = tools.get('a2a_connector_status');
  const first = await waitStatus(tool, value => value.running && value.tunnelOnline);
  assert.equal(await readFile(state, 'utf8'), credentials);
  assert.equal(first.logsAreHistorical, true);
  process.kill(first.pid, 'SIGKILL');
  const second = await waitStatus(tool, value => value.running && value.tunnelOnline && value.pid !== first.pid);
  assert.notEqual(second.logRun.id, first.logRun.id);
  assert.equal(await readFile(state, 'utf8'), credentials);
  await cleanup();
  const stopped = await waitStatus(tool, value => !value.running);
  assert.equal(stopped.restartScheduled, false);
  assert.equal(stopped.tunnelOnline, false);
  await assert.rejects(readFile(state + '.lock/owner.json'), { code: 'ENOENT' });
});

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
    'a2a_conversations', 'a2a_reconcile', 'a2a_connector_status', 'a2a_connector_pair']);
});
