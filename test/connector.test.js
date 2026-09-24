import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { Connector, loadEnrollment, loadPendingPairing, pairingStatus, register, requestPairing,
  saveEnrollment, waitForPairing } from '../src/connector.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

const run = promisify(execFile);

test('registers once and stores a private credential', async t => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.url, '/register');
    response.writeHead(calls === 1 ? 201 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(calls === 1 ? { agentId: 'coder', token: 'agt_coder.secret', card: 'https://relay/card' } : { error: 'invalid' }));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const relay = `ws://${new URL(base).host}/connect`;
  const code = 'pair_' + 'a'.repeat(48);
  const value = await register({ relay, code, allowInsecure: true });
  assert.equal(value.agentId, 'coder');
  const path = join(await mkdtemp(join(tmpdir(), 'a2a-connector-')), 'state.json');
  await saveEnrollment(path, value);
  assert.deepEqual(await loadEnrollment(path), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(register({ relay, code, allowInsecure: true }), /status 401/);
});

test('requests approval and redeems it without exposing a credential before approval', async t => {
  const requestId = 'a'.repeat(64);
  const code = 'pair_' + 'b'.repeat(48);
  let approved = false;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      assert.equal(request.method, 'POST');
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { agentId: 'coder', name: 'Coder' });
      response.writeHead(201);
      response.end(JSON.stringify({ requestId, agentId: 'coder', confirmationCode: 'ABC123', expiresAt: 1234567890 }));
    } else if (request.url === '/pairing/status') {
      assert.equal(request.method, 'POST');
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { requestId });
      response.end(JSON.stringify(approved ? { status: 'approved', code } : { status: 'pending', code: '' }));
    } else if (request.url === '/register') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { code });
      response.writeHead(201);
      response.end(JSON.stringify({ agentId: 'coder', token: 'agt_coder.secret' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const base = await listen(server);
  t.after(() => server.close());
  const relay = `ws://${new URL(base).host}/connect`;
  const pending = await requestPairing({ relay, agentId: 'coder', name: 'Coder', allowInsecure: true });
  const path = join(await mkdtemp(join(tmpdir(), 'a2a-pairing-')), 'pending.json');
  await saveEnrollment(path, pending);
  assert.deepEqual(await loadPendingPairing(path), pending);
  assert.deepEqual(await pairingStatus({ relay, requestId, allowInsecure: true }), { status: 'pending', code: '' });
  approved = true;
  const status = await waitForPairing({ relay, requestId, allowInsecure: true, interval: 1 });
  const enrolled = await register({ relay, code: status.code, allowInsecure: true });
  assert.equal(enrolled.token, 'agt_coder.secret');
});

test('CLI resumes a pending request and connects after approval', async t => {
  const local = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'Novice Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const requestId = 'c'.repeat(64);
  const code = 'pair_' + 'd'.repeat(48);
  let approved = false;
  let created = 0;
  const relay = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      created++;
      response.writeHead(201);
      response.end(JSON.stringify({ requestId, agentId: 'novice-agent-12345678', name: 'Novice Agent',
        confirmationCode: 'ABC123', expiresAt: Math.floor(Date.now() / 1000) + 600 }));
    } else if (request.url === '/pairing/status') {
      response.end(JSON.stringify(approved ? { status: 'approved', code } : { status: 'pending' }));
    } else if (request.url === '/register') {
      response.writeHead(201);
      response.end(JSON.stringify({ agentId: 'novice-agent-12345678', token: 'agt_novice-agent-12345678.secret' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  relay.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  const relayURL = await listen(relay);
  t.after(() => { wss.close(); relay.close(); });
  const state = join(await mkdtemp(join(tmpdir(), 'a2a-auto-pair-')), 'state.json');
  const args = ['src/cli.js', '-relay', `ws://${new URL(relayURL).host}/connect`, '-local', localURL,
    '-state', state, '-allow-insecure'];
  const requested = await run(process.execPath, [...args, '-request-only'], { timeout: 5000 });
  assert.equal(JSON.parse(requested.stdout).confirmationCode, 'ABC123');
  const child = spawn(process.execPath, [...args, '-auto-pair'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(() => child.kill('SIGTERM'));
  approved = true;
  let enrollment;
  for (let i = 0; i < 60; i++) {
    try { enrollment = await loadEnrollment(state); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(enrollment, `automatic enrollment did not complete: ${errors}`);
  assert.equal(enrollment.agentId, 'novice-agent-12345678');
  assert.equal(created, 1, 'the resumed Connector issued a duplicate request');
});

test('discovers a local Agent and forwards HTTP frames without leaking caller auth', async t => {
  const local = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer local-secret');
    if (request.url === '/.well-known/agent-card.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'Local Agent' }));
    } else {
      let body = '';
      for await (const part of request) body += part;
      assert.equal(request.url, '/a2a?test=1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    }
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const relay = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  relay.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.authorization, 'Bearer agent-secret');
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws);
    });
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'request.start', requestId: 'one', method: 'POST', path: '/a2a?test=1',
      headers: { Authorization: ['Bearer dsh-secret'], 'Content-Type': ['application/json'] } }));
    ws.send(JSON.stringify({ type: 'request.body', requestId: 'one', body: Buffer.from('{"method":"SendMessage"}').toString('base64') }));
    ws.send(JSON.stringify({ type: 'request.end', requestId: 'one' }));
    const frames = [];
    ws.on('message', raw => {
      frames.push(JSON.parse(raw.toString()));
      if (frames.at(-1).type === 'response.end') {
        completed(frames);
        ws.close();
      }
    });
  });
  const relayURL = await listen(relay);
  t.after(async () => { wss.close(); relay.close(); });
  const client = new Connector({ relay: `ws://${new URL(relayURL).host}/connect`, local: localURL,
    token: 'agent-secret', localToken: 'local-secret', allowInsecure: true });
  assert.equal((await client.discover()).name, 'Local Agent');
  let timer;
  try {
    await Promise.race([client.connectOnce(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); })]);
  } finally { clearTimeout(timer); }
  const frames = await done;
  assert.equal(frames[0].status, 200);
  assert.equal(Buffer.concat(frames.filter(x => x.type === 'response.body').map(x => Buffer.from(x.body, 'base64'))).toString(),
    '{"method":"SendMessage"}');
});
