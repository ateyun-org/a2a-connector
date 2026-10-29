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
import { Connector, loadEnrollment, register,
  saveEnrollment } from '../src/connector.js';

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

async function enrolledTunnel(t, relay, state, agentId) {
  await saveEnrollment(state, { agentId, token: `agt_${agentId}.test-private` });
  const wss = new WebSocketServer({ server: relay });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
}

test('shell installer prepares WorkBuddy settings without persisting a local token', async t => {
  const local = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-local-token');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: 'WorkBuddy Agent' }));
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const relay = createServer((_request, response) => { response.writeHead(404); response.end('{}'); });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-workbuddy-shell-'));
  await enrolledTunnel(t, relay, join(home, '.config', 'a2a-connector', 'workbuddy.json'), 'workbuddy-agent');
  const { stdout } = await run('sh', ['scripts/install-connector.sh', 'install', '--host', 'workbuddy',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--allow-insecure', '--expect-agent-id', 'workbuddy-agent'], { timeout: 5000,
    env: { ...process.env, HOME: home, A2A_LOCAL_TOKEN: 'test-local-token' } });
  assert.match(stdout, /Connector 已启动/);
  await run('sh', ['scripts/install-connector.sh', 'stop', '--host', 'workbuddy'], { env: { ...process.env, HOME: home } });
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
  const relay = createServer((_request, response) => { response.writeHead(404); response.end('{}'); });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-port-scan-'));
  await enrolledTunnel(t, relay, join(home, '.config', 'a2a-connector', 'workbuddy-target.json'), 'target-agent');
  const args = ['scripts/install-connector.sh', 'install', '--host', 'workbuddy', '--instance', 'target',
    '--expect-name', 'Target Agent', '--relay', `ws://${new URL(relayURL).host}/connect`,
    '--local', 'auto', '--port-start', String(startPort), '--allow-insecure', '--expect-agent-id', 'target-agent'];
  const result = await run('sh', args, { timeout: 8000,
    env: { ...process.env, HOME: home, A2A_LOCAL_TOKEN: 'test-local-token' } });
  assert.match(result.stdout, new RegExp(`http://127\\.0\\.0\\.1:${startPort + 1}`));
  assert.deepEqual(wrongAuth, [undefined]);
  assert.deepEqual(targetAuth, [undefined, 'Bearer test-local-token', 'Bearer test-local-token']);
  await run('sh', ['scripts/install-connector.sh', 'stop', '--host', 'workbuddy', '--instance', 'target'], { env: { ...process.env, HOME: home } });
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
  const relay = createServer((_request, response) => { response.writeHead(404); response.end('{}'); });
  const relayURL = await listen(relay);
  t.after(() => relay.close());
  const home = await mkdtemp(join(tmpdir(), 'a2a-workbuddy-lifecycle-'));
  await enrolledTunnel(t, relay, join(home, '.config', 'a2a-connector', 'workbuddy-reviewer.json'), 'lifecycle-agent');
  const env = { ...process.env, HOME: home };
  const baseArgs = ['scripts/install-connector.sh'];
  const pidFile = join(home, '.config', 'a2a-connector', 'workbuddy-reviewer.pid');
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGTERM'); }
    catch { /* Already stopped. */ }
  });
  const install = await run('sh', [...baseArgs, 'install', '--host', 'workbuddy',
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--instance', 'reviewer', '--expect-name', 'Lifecycle Agent', '--allow-insecure', '--expect-agent-id', 'lifecycle-agent'], { timeout: 8000, env });
  assert.match(install.stdout, /Connector 已启动/);
  const firstPid = await readFile(pidFile, 'utf8');
  await assert.rejects(run(process.execPath, ['plugins/workbuddy/cli.js', 'start'], { timeout: 5000,
    env: { ...env, A2A_CONNECTOR_INSTANCE: 'reviewer' } }), /Connector already running/);
  assert.equal(await readFile(pidFile, 'utf8'), firstPid);
  const status = await run('sh', [...baseArgs, 'status', '--host', 'workbuddy',
    '--instance', 'reviewer'], { timeout: 5000, env });
  assert.match(status.stdout, /Connector 进程：运行中/);
  assert.match(status.stdout, /a2a-[0-9a-f]{8}-workbuddy-reviewer/);
  await assert.rejects(run('sh', [...baseArgs, 'repair', '--host', 'workbuddy', '--expect-agent-id', 'lifecycle-agent', '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL, '--instance', 'reviewer', '--expect-name', 'Lifecycle Agent', '--allow-insecure'], { timeout: 10000, env }), /已有本机凭据/);
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
