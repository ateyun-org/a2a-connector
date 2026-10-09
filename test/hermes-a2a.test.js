import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createHermesDriver } from '../plugins/hermes/agent-driver.js';
import { createAdapterServer, listenAdapter } from '../plugins/hermes/adapter-server.js';
import { prepareHermesA2A } from '../plugins/hermes/runner.js';

const token = 'x'.repeat(64);
const execute = promisify(execFile);
const python = process.env.A2A_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

test('Hermes quiet driver resumes the returned session, follows compaction, and isolates contexts', async () => {
  const calls = [];
  const results = [
    { stdout: 'first', stderr: 'session_id: session-one\n' },
    { stdout: 'second', stderr: 'session_id: session-one\nsession_id: compacted\n' },
    { stdout: 'third', stderr: 'session_id: compacted\n' },
    { stdout: 'alone', stderr: 'session_id: another\n' },
  ];
  const create = createHermesDriver({ python: '/host/python', env: { HERMES_HOME: '/private/profile' },
    execute: async (...args) => { calls.push(args); return results.shift(); } });
  const one = create(), two = create();
  assert.equal(await one.run('a'), 'first');
  assert.equal(await one.run('b'), 'second');
  assert.equal(await one.run('c'), 'third');
  assert.equal(await two.run('d'), 'alone');
  assert.equal(calls[0][0], '/host/python');
  assert.deepEqual(calls[0][1], ['-m', 'hermes_cli.main', 'chat', '--quiet', '--query', 'a']);
  assert.deepEqual(calls[1][1].slice(-2), ['--resume', 'session-one']);
  assert.deepEqual(calls[2][1].slice(-2), ['--resume', 'compacted']);
  assert.ok(!calls[3][1].includes('--resume'));
  assert.equal(calls[0][2].env.HERMES_HOME, '/private/profile');
  assert.equal(calls[0][2].env.A2A_CONNECTOR_CHILD, '1');
  create.close();
  assert.ok(calls[0][2].signal.aborted);
});

test('Hermes CLI failure and missing session/text are never reported as successful tasks', async () => {
  for (const execute of [async () => { throw new Error('Hermes failed (exit 1)'); },
    async () => ({ stdout: 'error explanation', stderr: '' }),
    async () => ({ stdout: '', stderr: 'session_id: a\n' })]) {
    const create = createHermesDriver({ execute });
    await assert.rejects(create().run('task'));
    create.close();
  }
});

test('runner reuses native A2A without loading compatibility code', async () => {
  const result = await prepareHermesA2A({ env: { A2A_HERMES_PYTHON: '/host/python', A2A_LOCAL_TOKEN: token },
    run: async (binary, args) => {
      assert.equal(binary, '/host/python'); assert.ok(args[0].endsWith(join('hermes', 'a2a_support.py')));
      return { stdout: JSON.stringify({ mode: 'native', local: 'http://127.0.0.1:9900' }) };
    } });
  assert.equal(result.mode, 'native'); assert.equal(result.token, token);
  await result.close();
  await assert.rejects(prepareHermesA2A({ run: async () => { throw new Error('Native authentication failed'); } }));
  await assert.rejects(prepareHermesA2A({ run: async () => ({ stdout: '{}' }) }), /capability/);
});

test('Hermes adapter authenticates discovery/RPC, returns artifacts and refuses overlap/cancellation', async t => {
  let finish;
  const adapter = createAdapterServer({ token, createSession: () => ({ run: () => new Promise(resolve => { finish = resolve; }) }) });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const origin = `http://127.0.0.1:${adapter.server.address().port}`;
  assert.equal((await fetch(`${origin}/.well-known/agent-card.json`)).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const rpc = async (method, params) => (await fetch(`${origin}/a2a/v1`, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const card = await (await fetch(`${origin}/.well-known/agent-card.json`, { headers })).json();
  assert.equal(card.name, 'Hermes Agent');
  assert.equal(card.supportedInterfaces[0].url, `${origin}/a2a/v1`);
  const task = (await rpc('SendMessage', { message: { messageId: 'one', role: 'ROLE_USER', parts: [{ text: 'hello' }] } })).result.task;
  assert.equal(task.status.state, 'TASK_STATE_WORKING');
  assert.ok((await rpc('SendMessage', { message: { messageId: 'two', contextId: task.contextId, role: 'ROLE_USER', parts: [{ text: 'overlap' }] } })).error);
  assert.equal((await rpc('CancelTask', { id: task.id })).error.code, -32004);
  finish('host reply');
  const done = (await rpc('GetTask', { id: task.id })).result;
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(done.artifacts[0].parts[0].text, 'host reply');
  const duplicate = await rpc('SendMessage', { message: { messageId: 'one', contextId: task.contextId, role: 'ROLE_USER', parts: [{ text: 'hello' }] } });
  assert.equal(duplicate.result.task.id, task.id);
});

test('compatibility server handles an occupied port and binds loopback', async t => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const adapter = createAdapterServer({ token, createSession: () => ({}) });
  t.after(() => adapter.close());
  const port = await listenAdapter(adapter.server, occupied.address().port);
  assert.ok(port > occupied.address().port);
  assert.equal(adapter.server.address().address, '127.0.0.1');
});

test('legacy Hermes runner forwards real Relay frames to isolated quiet CLI sessions', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-a2a-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = join(dir, 'host'), home = join(dir, 'profile');
  await mkdir(join(host, 'hermes_cli'), { recursive: true });
  await writeFile(join(host, 'hermes_cli/__init__.py'), '');
  await writeFile(join(host, 'run_agent.py'), '# Actual source-root detection; no native A2A module\n');
  await writeFile(join(host, 'hermes_cli/main.py'), `import os,sys,uuid,json\nfrom pathlib import Path\nassert os.environ['A2A_CONNECTOR_CHILD']=='1'\na=sys.argv[1:]\nsid=a[a.index('--resume')+1] if '--resume' in a else uuid.uuid4().hex\np=Path(os.environ['HERMES_HOME'])/sid\nh=json.loads(p.read_text()) if p.exists() else []\nh.append(a[a.index('--query')+1])\np.write_text(json.dumps(h))\nprint('|'.join(h))\nprint('session_id: '+sid,file=sys.stderr)\n`);
  await mkdir(home);
  const state = join(dir, 'private/hermes.json');
  await mkdir(join(dir, 'private'), { mode: 0o700 });
  await writeFile(state, JSON.stringify({ agentId: 'hermes-test', token }), { mode: 0o600 });
  const relay = createServer(), ws = new WebSocketServer({ server: relay });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => relay.close(resolve)); });
  const connected = new Promise(resolve => ws.once('connection', resolve));
  const wrapperArgs = [resolve('plugins/hermes/runner.js'), '-auto-pair', '-state', state,
    '-relay', `ws://127.0.0.1:${relay.address().port}/connect`, '-local', 'auto', '-allow-insecure'];
  const wrapperEnv = { ...process.env, HERMES_HOME: home, PYTHONPATH: host, A2A_HERMES_PYTHON: python, A2A_HERMES_BINARY: '',
    A2A_LOCAL_URL: 'auto', A2A_LOCAL_TOKEN: '', A2A_BEARER_TOKEN: '', A2A_PEER_TOKENS: '', HERMES_BUNDLED_PLUGINS: '' };
  const child = spawn(process.execPath, wrapperArgs, {
    env: wrapperEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8192); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = () => execute(process.execPath, [...wrapperArgs, '-stop'], { env: wrapperEnv });
  t.after(async () => { if (child.exitCode === null) await stop(); await closed; });
  const socket = await Promise.race([connected, closed.then(code => { throw new Error(`Runner exited (${code}): ${logs}`); })]);
  const runtime = JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8'));
  assert.equal(runtime.mode, 'compat');
  assert.equal(runtime.pid, child.pid);
  if (process.platform !== 'win32') assert.equal((await stat(state + '.a2a-runtime.json')).mode & 0o777, 0o600);
  const duplicate = spawn(process.execPath, wrapperArgs, { env: wrapperEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let duplicateError = '';
  duplicate.stderr.on('data', chunk => { duplicateError += chunk; });
  assert.equal(await new Promise(resolve => duplicate.once('close', resolve)), 1);
  assert.match(duplicateError, /state_locked/);
  assert.equal(JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8')).pid, child.pid);
  const forward = (method, path, body) => new Promise(resolve => {
    const requestId = randomUUID(), chunks = [];
    const onMessage = raw => {
      const frame = JSON.parse(raw);
      if (frame.requestId !== requestId) return;
      if (frame.type === 'response.body') chunks.push(Buffer.from(frame.body, 'base64'));
      if (frame.type === 'response.end') { socket.off('message', onMessage); resolve(JSON.parse(Buffer.concat(chunks))); }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'request.start', requestId, method, path, headers: {} }));
    if (body) socket.send(JSON.stringify({ type: 'request.body', requestId, body: Buffer.from(JSON.stringify(body)).toString('base64') }));
    socket.send(JSON.stringify({ type: 'request.end', requestId }));
  });
  assert.equal((await forward('GET', '/.well-known/agent-card.json')).name, 'Hermes Agent');
  const send = (text, contextId) => forward('POST', '/a2a/v1', { jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...(contextId ? { contextId } : {}) }, configuration: { blocking: true } } });
  const first = (await send('remember apple')).result.task;
  assert.equal(first.status.state, 'TASK_STATE_COMPLETED');
  assert.equal((await send('recall', first.contextId)).result.task.artifacts[0].parts[0].text, 'remember apple|recall');
  assert.equal((await send('alone')).result.task.artifacts[0].parts[0].text, 'alone');
  // Pairing inspection reuses the live private origin/token; it does not bind a second adapter.
  const reused = await prepareHermesA2A({ state, short: true, run: () => { throw new Error('Must reuse runtime'); } });
  assert.equal(reused.local, runtime.local); assert.equal(reused.token, runtime.token);
  await reused.close();
  // A crashed CLI is restarted by the same runner without reopening the adapter.
  const oldCLI = JSON.parse(await readFile(state + '.lock/owner.json', 'utf8'));
  const reconnected = new Promise(resolve => ws.once('connection', resolve));
  process.kill(oldCLI.pid, 'SIGKILL');
  await reconnected;
  const newCLI = JSON.parse(await readFile(state + '.lock/owner.json', 'utf8'));
  assert.notEqual(newCLI.pid, oldCLI.pid);
  assert.equal(newCLI.parentInstance, runtime.instanceId);
  assert.equal(JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8')).pid, child.pid);
  await stop();
  assert.equal(await closed, 0);
  await assert.rejects(stat(state + '.a2a-runtime.json'), { code: 'ENOENT' });
  await assert.rejects(stat(state + '.hermes-runner.lock'), { code: 'ENOENT' });
  await assert.rejects(stat(state + '.lock'), { code: 'ENOENT' });
});

test('managed stop recovers both abandoned locks and runtime metadata without touching a reused PID', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-stale-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'hermes.json');
  const credentials = JSON.stringify({ agentId: 'existing', token: 'kept-secret' });
  await writeFile(state, credentials, { mode: 0o600 });
  const old = { pid: process.pid, hostname: hostname(), instanceId: 'old', processIdentity: 'previous-boot' };
  for (const suffix of ['.lock', '.hermes-runner.lock']) {
    await mkdir(state + suffix);
    await writeFile(state + suffix + '/owner.json', JSON.stringify(old));
  }
  await writeFile(state + '.a2a-runtime.json', JSON.stringify({ pid: process.pid, instanceId: 'old', phase: 'running' }), { mode: 0o600 });
  await writeFile(join(dir, 'hermes.pid'), String(process.pid));
  const env = { ...process.env, A2A_NODE_BINARY: process.execPath, A2A_CONNECTOR_STATE: state };
  assert.match((await execute(python, [resolve('plugins/hermes/__init__.py'), 'stop'], { env })).stdout, /stopped/);
  for (const suffix of ['.lock', '.hermes-runner.lock', '.a2a-runtime.json']) {
    await assert.rejects(stat(state + suffix), { code: 'ENOENT' });
  }
  await assert.rejects(stat(join(dir, 'hermes.pid')), { code: 'ENOENT' });
  assert.equal(await readFile(state, 'utf8'), credentials);
  const health = JSON.parse((await execute(python, [resolve('plugins/hermes/__init__.py'), 'status'], { env })).stdout);
  assert.equal(health.running, false);
});

test('managed stop aborts a blocked startup probe and releases the wrapper without starting a CLI', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-starting-'));
  const state = join(dir, 'private folder/hermes.json');
  let reached;
  const probing = new Promise(resolve => { reached = resolve; });
  const local = createServer(() => reached()); // Keep the source capability probe waiting.
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, A2A_HERMES_PYTHON: python };
  const args = [resolve('plugins/hermes/runner.js'), '-state', state, '-auto-pair',
    '-local', `http://127.0.0.1:${local.address().port}`, '-relay', 'wss://relay.example/connect'];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  const stop = () => execute(process.execPath, [...args, '-stop'], { env });
  t.after(async () => {
    if (child.exitCode === null) await stop();
    await closed;
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.race([probing, closed.then(code => { throw new Error(`Startup exited (${code}): ${logs}`); })]);
  const runtime = JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8'));
  assert.equal(runtime.phase, 'starting');
  assert.equal(JSON.parse((await stop()).stdout).stopped, true);
  assert.equal(await closed, 0);
  for (const suffix of ['.lock', '.hermes-runner.lock', '.a2a-runtime.json', '.hermes-stop.json']) {
    await assert.rejects(stat(state + suffix), { code: 'ENOENT' });
  }
});

test('Python plugin pairs, checks and stops a managed or manually started runner without Gateway restart', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-lifecycle-'));
  const host = join(dir, 'host with spaces'), home = join(dir, 'profile');
  await mkdir(join(host, 'hermes_cli'), { recursive: true });
  await mkdir(home);
  await writeFile(join(host, 'hermes_cli/__init__.py'), '');
  await writeFile(join(host, 'run_agent.py'), '# Legacy Hermes\n');
  const state = join(dir, 'private folder/hermes.json');
  await mkdir(join(dir, 'private folder'));
  // An expired request must be renewed by the one managed worker, before showing approval.
  await writeFile(state + '.pending', JSON.stringify({ requestId: 'e'.repeat(64), agentId: 'managed-hermes',
    confirmationCode: 'ABCDEF', expiresAt: 1 }), { mode: 0o600 });
  // Both locks and runtime/PID metadata can survive shutdown. A reused PID must
  // not make Python regard this previous runner as live or terminate this test.
  const abandoned = { pid: process.pid, hostname: hostname(), instanceId: 'previous-run', processIdentity: 'previous-boot' };
  for (const suffix of ['.lock', '.hermes-runner.lock']) {
    await mkdir(state + suffix);
    await writeFile(state + suffix + '/owner.json', JSON.stringify(abandoned));
  }
  await writeFile(state + '.a2a-runtime.json', JSON.stringify({ pid: process.pid, instanceId: 'previous-run', phase: 'running' }), { mode: 0o600 });
  await writeFile(state.replace(/\.json$/, '.pid'), String(process.pid));
  let approved = false, requests = 0, registrations = 0;
  const requestId = 'a'.repeat(64), code = 'pair_' + 'b'.repeat(48);
  const relay = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pairing/requests') {
      requests++; assert.equal(body.agentId, 'managed-hermes'); res.writeHead(201);
      res.end(JSON.stringify({ requestId, agentId: body.agentId, confirmationCode: '123ABC', expiresAt: Math.floor(Date.now() / 1000) + 600 }));
    } else if (req.url === '/pairing/status') {
      if (body.requestId !== requestId) { res.writeHead(404); res.end('{}'); }
      else res.end(JSON.stringify(approved ? { status: 'approved', code } : { status: 'pending' }));
    } else if (req.url === '/register') {
      registrations++; assert.equal(body.code, code); res.writeHead(201);
      res.end(JSON.stringify({ agentId: 'managed-hermes', token }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  const ws = new WebSocketServer({ server: relay });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env, HERMES_HOME: home, PYTHONPATH: host, A2A_NODE_BINARY: process.execPath,
    A2A_CONNECTOR_STATE: state, A2A_LOCAL_URL: 'auto', A2A_RELAY_URL: `ws://127.0.0.1:${relay.address().port}/connect`,
    A2A_ALLOW_INSECURE: '1', A2A_AGENT_ID: '', A2A_LOCAL_TOKEN: '', A2A_BEARER_TOKEN: '', A2A_PEER_TOKENS: '', HERMES_BUNDLED_PLUGINS: '' };
  const plugin = resolve('plugins/hermes/__init__.py');
  const command = async name => (await execute(python, [plugin, name], { env, timeout: 28000 })).stdout.trim();
  t.after(async () => {
    await command('stop');
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => relay.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const pairing = JSON.parse(await command('pair'));
  assert.equal(pairing.confirmationCode, '123ABC');
  assert.equal(pairing.status, 'pending');
  assert.equal(requests, 1);
  const pendingHealth = JSON.parse(await command('status'));
  assert.equal(pendingHealth.running, true);
  assert.equal(pendingHealth.tunnelOnline, false);
  assert.match(await command('start'), /already running/);
  assert.equal(JSON.parse(await command('status')).pid, pendingHealth.pid);
  const connected = new Promise(resolve => ws.once('connection', resolve));
  approved = true;
  await connected;
  const health = JSON.parse(await command('status'));
  assert.equal(health.paired, true); assert.equal(health.tunnelOnline, true);
  assert.equal(registrations, 1);
  assert.ok(!JSON.stringify(health).includes(token));
  await command('stop');
  for (const suffix of ['.lock', '.hermes-runner.lock', '.a2a-runtime.json', '.hermes-stop.json']) {
    await assert.rejects(stat(state + suffix), { code: 'ENOENT' });
  }
  assert.equal(JSON.parse(await command('status')).running, false);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).token, token);
  // A manual runner has no Python PID file. Status/start/stop still find its canonical owner.
  const manual = spawn(process.execPath, [resolve('plugins/hermes/runner.js'), '-auto-pair', '-state', state,
    '-relay', env.A2A_RELAY_URL, '-local', 'auto', '-allow-insecure'], {
    env: { ...env, A2A_HERMES_PYTHON: python }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  manual.stderr.resume();
  const exited = new Promise(resolve => manual.once('close', resolve));
  await new Promise(resolve => ws.once('connection', resolve));
  assert.match(await command('start'), /already running/);
  assert.equal(JSON.parse(await command('status')).pid, manual.pid);
  await command('stop');
  assert.equal(await exited, 0);
  assert.equal(registrations, 1);
});
