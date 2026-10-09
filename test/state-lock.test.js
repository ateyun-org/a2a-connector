import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { acquireStateLock, canonicalState, connectorStatus } from '../src/state-lock.js';
import { Connector } from '../src/connector.js';

const run = promisify(execFile);

test('canonical paths share an atomic lock, duplicate CLI fails before networking, and release allows restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = directory + '-alias';
  await symlink(directory, alias); t.after(() => rm(alias, { force: true }));
  const state = await canonicalState(join(directory, 'state.json'));
  assert.equal(await canonicalState(join(alias, 'state.json')), state);
  const lock = await acquireStateLock(state);
  t.after(() => lock.release());
  await assert.rejects(acquireStateLock(state), /state_locked/);
  await assert.rejects(run(process.execPath, ['src/cli.js', '-state', join(alias, 'state.json'),
    '-pair-code', 'pair_' + 'a'.repeat(48), '-relay', 'ws://127.0.0.1:1/connect', '-allow-insecure']), /state_locked/);
  await lock.release();
  const restarted = await acquireStateLock(state); await restarted.release();
});

test('CLI status reports live tunnel, then stopped after child is killed without graceful cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await canonicalState(join(directory, 'state.json'));
  const local = createServer((_req, res) => res.end(JSON.stringify({ name: 'Health Agent' })));
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  t.after(() => { for (const client of relay.clients) client.terminate(); relay.close(); });
  const child = spawn(process.execPath, ['src/cli.js', '-state', state, '-token', 'agt_health.secret',
    '-relay', `ws://127.0.0.1:${relay.address().port}/connect`, '-local', `http://127.0.0.1:${local.address().port}`, '-allow-insecure'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI did not connect')), 3000);
    child.once('error', reject);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('tunnel connected')) { clearTimeout(timer); resolve(); } });
  });
  const { stdout } = await run(process.execPath, ['src/cli.js', '-state', state, '-status']);
  const status = JSON.parse(stdout);
  assert.equal(status.tunnelOnline, true); assert.equal(status.running, true);
  assert.equal(status.agentId, 'health'); assert.ok(status.lastConnectedAt);
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGKILL'); await closed;
  const stopped = await connectorStatus(state);
  assert.equal(stopped.running, false); assert.equal(stopped.tunnelOnline, false);
  assert.equal(stopped.lastConnectedAt, undefined); // Recent output from a dead run is not current health.
  const restarted = await acquireStateLock(state);
  assert.notEqual(restarted.owner.pid, stopped.pid);
  await restarted.release();
});

async function staleFixture(t, owner) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-stale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state.json');
  await mkdir(state + '.lock');
  await writeFile(state + '.lock/owner.json', JSON.stringify(owner));
  return state;
}

test('reused PID is recovered by process birth identity, preserving credentials and replacement ownership', async t => {
  const state = await staleFixture(t, { pid: process.pid, hostname: hostname(), instanceId: 'old', processIdentity: 'previous-boot' });
  await writeFile(state, 'saved-secret');
  const lock = await acquireStateLock(state);
  assert.notEqual(lock.owner.instanceId, 'old');
  assert.ok(lock.owner.processIdentity);
  assert.equal(await readFile(state, 'utf8'), 'saved-secret');
  await assert.rejects(acquireStateLock(state), /state_locked/);
  await lock.release();
  const next = await acquireStateLock(state);
  await lock.release(); // A delayed old release cannot remove a replacement's lock.
  await assert.rejects(acquireStateLock(state), /state_locked/);
  await next.release();
});

test('foreign, unknown and live legacy owners are retained', async t => {
  for (const owner of [{ pid: process.pid, hostname: 'another-host', instanceId: 'old' },
    { pid: process.pid, hostname: hostname(), instanceId: 'legacy' },
    { pid: process.pid, hostname: hostname(), instanceId: 'invalid-identity', processIdentity: {} },
    { hostname: hostname(), instanceId: 'invalid' }]) {
    const state = await staleFixture(t, owner);
    await assert.rejects(acquireStateLock(state), /state_locked/);
    assert.deepEqual(JSON.parse(await readFile(state + '.lock/owner.json', 'utf8')), owner);
  }
  const damaged = await staleFixture(t, { pid: process.pid });
  await writeFile(damaged + '.lock/owner.json', '{broken');
  await assert.rejects(acquireStateLock(damaged), SyntaxError);
  assert.equal(await readFile(damaged + '.lock/owner.json', 'utf8'), '{broken');
});

test('concurrent processes reclaim an abandoned lock and only one becomes owner', async t => {
  const dead = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  const closed = new Promise(resolve => dead.once('close', resolve));
  await new Promise(resolve => dead.once('spawn', resolve));
  dead.kill('SIGKILL'); await closed;
  const owner = { pid: dead.pid, hostname: hostname(), instanceId: 'crashed' };
  const state = await staleFixture(t, owner);
  // A crash during an earlier recovery must not leave a second permanent lock.
  await mkdir(state + '.lock/recovery.lock');
  await writeFile(state + '.lock/recovery.lock/owner.json', JSON.stringify(owner));
  const script = `import {acquireStateLock} from './src/state-lock.js';
    const lock = await acquireStateLock(process.argv[1]);
    console.log('acquired'); await new Promise(r=>setTimeout(r,500)); await lock.release();`;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => run(process.execPath,
    ['--input-type=module', '-e', script, state])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.match(result.reason.stderr, /state_locked/);
  const next = await acquireStateLock(state); await next.release();
});

test('smaller ingress limit rejects oversized chunks before contacting the local origin', async () => {
  const connector = new Connector({ relay: 'wss://relay.example/connect', local: 'http://127.0.0.1:1',
    token: 'test', maxRequestBodyBytes: 1024 });
  assert.equal(connector.config.maxRequestBodyBytes, 1024);
  assert.throws(() => new Connector({ ...connector.config, maxRequestBodyBytes: 0 }), /maxRequestBodyBytes/);
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.once('listening', resolve));
  connector.config.relay = `ws://127.0.0.1:${relay.address().port}`;
  let forwarded = false;
  connector.forward = async () => { forwarded = true; };
  const controller = new AbortController();
  const done = new Promise(resolve => relay.once('connection', socket => {
    socket.send(JSON.stringify({ type: 'request.start', requestId: 'large', method: 'POST', path: '/rpc' }));
    socket.send(JSON.stringify({ type: 'request.body', requestId: 'large', body: Buffer.alloc(1025).toString('base64') }));
    socket.send(JSON.stringify({ type: 'request.end', requestId: 'large' }));
    socket.on('message', raw => { const frame = JSON.parse(raw); if (frame.type === 'response.start') { resolve(frame.status); controller.abort(); } });
  }));
  try {
    const connection = connector.connectOnce(controller.signal);
    assert.equal(await done, 413); await connection; assert.equal(forwarded, false);
  } finally { for (const client of relay.clients) client.terminate(); relay.close(); }
});
