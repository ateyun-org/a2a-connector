import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createHermesDriver } from '../plugins/hermes/agent-driver.js';
import { createAdapterServer, listenAdapter } from '../plugins/hermes/adapter-server.js';
import { prepareHermesA2A } from '../plugins/hermes/runner.js';

const token = 'x'.repeat(64);

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
      assert.equal(binary, '/host/python'); assert.ok(args[0].endsWith('/a2a_support.py'));
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
  const wrapperEnv = { ...process.env, HERMES_HOME: home, PYTHONPATH: host, A2A_HERMES_PYTHON: 'python3', A2A_HERMES_BINARY: '',
    A2A_LOCAL_URL: 'auto', A2A_LOCAL_TOKEN: '', A2A_BEARER_TOKEN: '', A2A_PEER_TOKENS: '', HERMES_BUNDLED_PLUGINS: '' };
  const child = spawn(process.execPath, wrapperArgs, {
    env: wrapperEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-8192); });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await closed; });
  const socket = await Promise.race([connected, closed.then(code => { throw new Error(`Runner exited (${code}): ${logs}`); })]);
  const runtime = JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8'));
  assert.equal(runtime.mode, 'compat');
  assert.equal(runtime.pid, child.pid);
  assert.equal((await stat(state + '.a2a-runtime.json')).mode & 0o777, 0o600);
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
  child.kill('SIGTERM');
  assert.equal(await closed, 0);
  await assert.rejects(stat(state + '.a2a-runtime.json'), { code: 'ENOENT' });
  await assert.rejects(stat(state + '.hermes-runner.lock'), { code: 'ENOENT' });
});
