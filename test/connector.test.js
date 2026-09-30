import { canonicalState } from '../src/state-lock.js';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

test('CLI stops after a rejected one-time pairing code and preserves pending state', async t => {
  const local = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'Recovery Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  let registrations = 0;
  const relay = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      response.writeHead(201);
      response.end(JSON.stringify({ requestId: 'e'.repeat(64), agentId: 'recovery-agent',
        confirmationCode: 'ABC123' }));
    } else if (request.url === '/pairing/status') {
      response.end(JSON.stringify({ status: 'approved', code: 'pair_' + 'f'.repeat(48) }));
    } else if (request.url === '/register') {
      registrations++;
      response.writeHead(401);
      response.end(JSON.stringify({ error: 'invalid_pairing_code' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const state = join(await mkdtemp(join(tmpdir(), 'a2a-rejected-pair-')), 'state.json');
  await assert.rejects(run(process.execPath, ['src/cli.js', '-relay', `ws://${new URL(relayURL).host}/connect`,
    '-local', localURL, '-state', state, '-allow-insecure', '-auto-pair'], { timeout: 5000 }),
  /pairing code rejected \(401\)/);
  assert.equal(registrations, 1);
  assert.equal((await loadPendingPairing(state + '.pending')).confirmationCode, 'ABC123');
});

test('CLI stops on an unmatched pairing conflict instead of retrying forever', async t => {
  const local = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'Conflict Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  let requests = 0;
  const relay = createServer((request, response) => {
    requests++;
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'pairing_already_pending' }));
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const state = join(await mkdtemp(join(tmpdir(), 'a2a-pair-conflict-')), 'state.json');
  await assert.rejects(run(process.execPath, ['src/cli.js', '-relay', `ws://${new URL(relayURL).host}/connect`,
    '-local', localURL, '-state', state, '-allow-insecure', '-auto-pair'], { timeout: 5000 }),
  /another pairing request already uses this Agent ID/);
  assert.equal(requests, 1);
});

test('shell installer preflights the origin and reuses one pending request', async t => {
  const local = createServer((request, response) => {
    assert.equal(request.url, '/.well-known/agent-card.json');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'Script Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  let created = 0;
  const relay = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      created++;
      response.writeHead(201);
      response.end(JSON.stringify({ requestId: '9'.repeat(64), agentId: 'script-agent-12345678',
        confirmationCode: 'ABC123' }));
    } else if (request.url === '/pairing/status') {
      response.end(JSON.stringify({ status: 'pending' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const state = join(await mkdtemp(join(tmpdir(), 'a2a-shell-install-')), 'state.json');
  const args = ['scripts/install-connector.sh', 'install', '--host', 'openclaw',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--state', state, '--allow-insecure', '--request-only'];
  const first = await run('sh', args, { timeout: 5000 });
  const shimDir = await mkdtemp(join(tmpdir(), 'a2a-pgrep-shim-'));
  await writeFile(join(shimDir, 'pgrep'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_PGREP_LINE"\n', { mode: 0o755 });
  const second = await run('sh', args, { timeout: 5000,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
      FAKE_PGREP_LINE: `424242 awk -v state=${state} -v signature=a2a-01234567` } });
  assert.match(first.stdout, /ABC123/);
  assert.match(second.stdout, /ABC123/);
  assert.equal(created, 1);
  const title = `a2a-${createHash('sha256').update(await canonicalState(state)).digest('hex').slice(0, 8)}-state`;
  const duplicate = spawn(process.execPath, ['-e',
    'process.title=process.argv[1]; console.log("ready"); setInterval(() => {}, 1000)', title],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => duplicate.kill('SIGTERM'));
  await once(duplicate.stdout, 'data');
  await assert.rejects(run('sh', args, { timeout: 5000 }), /另有 Connector 进程使用此状态文件/);
  assert.equal(created, 1, 'a duplicate process must block a second pairing attempt');
  assert.equal((await loadPendingPairing(state + '.pending')).agentId, 'script-agent-12345678');
  const status = await run('sh', ['scripts/install-connector.sh', 'status', '--host', 'openclaw',
    '--state', state], { timeout: 5000 });
  assert.match(status.stdout, /Connector 进程：未运行/);
});

test('shell installer prepares WorkBuddy settings without persisting a local token', async t => {
  const local = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-local-token');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'WorkBuddy Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const relay = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      response.writeHead(201);
      response.end(JSON.stringify({ requestId: '8'.repeat(64), agentId: 'workbuddy-agent-12345678',
        confirmationCode: 'DEF456' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-workbuddy-shell-'));
  const { stdout } = await run('sh', ['scripts/install-connector.sh', 'install', '--host', 'workbuddy',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--allow-insecure', '--request-only'], { timeout: 5000,
    env: { ...process.env, HOME: home, A2A_LOCAL_TOKEN: 'test-local-token' } });
  assert.match(stdout, /DEF456/);
  const settings = JSON.parse(await readFile(
    join(home, '.config', 'a2a-connector', 'workbuddy-settings.json'), 'utf8'));
  assert.equal(settings.local, localURL);
  assert.equal(settings.allowInsecure, true);
  assert.ok(!JSON.stringify(settings).includes('test-local-token'));
});

test('shell installer scans occupied A2A ports by exact Agent Card name', async t => {
  let wrong, target, startPort;
  const wrongAuth = [], targetAuth = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    wrong = createServer((request, response) => {
      wrongAuth.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: 'Other Agent' }));
    });
    await listen(wrong);
    startPort = wrong.address().port;
    target = createServer((request, response) => {
      targetAuth.push(request.headers.authorization);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: 'Target Agent' }));
    });
    try {
      await new Promise((resolve, reject) => {
        target.once('error', reject);
        target.listen(startPort + 1, '127.0.0.1', resolve);
      });
      break;
    } catch {
      await new Promise(resolve => wrong.close(resolve));
      wrong = undefined;
    }
  }
  assert.ok(wrong && target.listening, 'could not reserve adjacent test ports');
  t.after(() => new Promise(resolve => wrong.close(resolve)));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const requests = [];
  const relay = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.writeHead(201);
    response.end(JSON.stringify({ requestId: '6'.repeat(64), agentId: 'target-agent-12345678',
      confirmationCode: 'ABCDEF' }));
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-port-scan-'));
  const args = ['scripts/install-connector.sh', 'install', '--host', 'workbuddy', '--instance', 'target',
    '--expect-name', 'Target Agent', '--relay', `ws://${new URL(relayURL).host}/connect`,
    '--local', 'auto', '--port-start', String(startPort), '--allow-insecure', '--request-only'];
  const result = await run('sh', args, { timeout: 8000,
    env: { ...process.env, HOME: home, A2A_LOCAL_TOKEN: 'test-local-token' } });
  assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${startPort + 1}`));
  assert.deepEqual(wrongAuth, [undefined]);
  assert.deepEqual(targetAuth, [undefined, 'Bearer test-local-token', 'Bearer test-local-token']);
  assert.equal(requests.filter(path => path === '/pairing/requests').length, 1);
  const settings = JSON.parse(await readFile(join(home, '.config', 'a2a-connector',
    'workbuddy-target-settings.json'), 'utf8'));
  assert.equal(settings.local, `http://127.0.0.1:${startPort + 1}`);
});

test('shell installer starts and stops one WorkBuddy Connector process', async t => {
  const local = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'Lifecycle Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const relay = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/pairing/requests') {
      response.writeHead(201);
      response.end(JSON.stringify({ requestId: '7'.repeat(64), agentId: 'lifecycle-agent-12345678',
        confirmationCode: '789ABC' }));
    } else if (request.url === '/pairing/status') {
      response.end(JSON.stringify({ status: 'pending' }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-workbuddy-lifecycle-'));
  const env = { ...process.env, HOME: home };
  const baseArgs = ['scripts/install-connector.sh'];
  const pidFile = join(home, '.config', 'a2a-connector', 'workbuddy-reviewer.pid');
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGTERM'); }
    catch { /* Already stopped. */ }
  });
  const install = await run('sh', [...baseArgs, 'install', '--host', 'workbuddy',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--instance', 'reviewer', '--expect-name', 'Lifecycle Agent', '--allow-insecure'], { timeout: 8000, env });
  assert.match(install.stdout, /Connector 已启动/);
  const firstPid = await readFile(pidFile, 'utf8');
  await assert.rejects(run(process.execPath, ['plugins/workbuddy/cli.js', 'start'], { timeout: 5000,
    env: { ...env, A2A_CONNECTOR_INSTANCE: 'reviewer' } }), /Connector already running/);
  assert.equal(await readFile(pidFile, 'utf8'), firstPid);
  const status = await run('sh', [...baseArgs, 'status', '--host', 'workbuddy',
    '--instance', 'reviewer'], { timeout: 5000, env });
  assert.match(status.stdout, /Connector 进程：运行中/);
  assert.match(status.stdout, /a2a-[0-9a-f]{8}-workbuddy-reviewer/);
  const repaired = await run('sh', [...baseArgs, 'repair', '--host', 'workbuddy',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--instance', 'reviewer', '--expect-name', 'Lifecycle Agent', '--allow-insecure'], { timeout: 10000, env });
  assert.match(repaired.stdout, /已归档失效的待审批文件/);
  assert.ok((await readdir(join(home, '.config', 'a2a-connector')))
    .some(name => name.startsWith('workbuddy-reviewer.json.pending.backup-')));
  const stopped = await run('sh', [...baseArgs, 'stop', '--host', 'workbuddy',
    '--instance', 'reviewer'], { timeout: 8000, env });
  assert.match(stopped.stdout, /已请求 Connector 停止/);
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
