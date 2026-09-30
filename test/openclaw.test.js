import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { selectA2A } from '../plugins/openclaw/a2a-selection.js';
import { createAgentDriver } from '../plugins/openclaw/agent-driver.js';
import { createAdapterServer, listenAdapter } from '../plugins/openclaw/adapter-server.js';
import plugin from '../plugins/openclaw/index.js';
import { installOpenClaw } from '../scripts/install-openclaw.mjs';

const token = 'x'.repeat(64);
const inventory = ids => async () => ({ stdout: JSON.stringify({ plugins: ids.map(id => ({ id })) }) });
const card = origin => new Response(JSON.stringify({ name: 'Native OpenClaw',
  supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `${origin}/a2a/v1` }] }));
const nativeResponse = (url, options) => options.method === 'POST'
  ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 'connector-auth-probe', error: { code: -32001, message: 'Task not found' } }))
  : card(new URL(url).origin);
const neverFetch = () => { throw new Error('Legacy detection must use the inventory, not a failed HTTP request'); };

test('native A2A is preferred based on capability, and absence alone permits compatibility', async () => {
  const config = { openclawBinary: '/host/openclaw', openclawArgs: ['--profile', 'reviewer'] };
  const hostConfig = { gateway: { port: 19876 } };
  let invocation;
  const native = await selectA2A({ config, hostConfig, token, execute: async (...args) => {
    invocation = args; return inventory(['a2a'])();
  }, fetcher: async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.ok(url.startsWith('http://127.0.0.1:19876/'));
    return nativeResponse(url, options);
  } });
  assert.deepEqual(native, { mode: 'native', local: 'http://127.0.0.1:19876' });
  assert.equal(invocation[0], config.openclawBinary);
  assert.deepEqual(invocation[1], ['--profile', 'reviewer', 'plugins', 'list', '--json']);
  assert.deepEqual(await selectA2A({ execute: inventory(['telegram']), fetcher: neverFetch }), { mode: 'compat' });
});

test('disabled, broken, unreachable native A2A and unknown inventories never select compatibility', async () => {
  for (const fetcher of [async () => new Response('', { status: 404 }),
    async () => new Response('', { status: 401 }), async () => new Response('', { status: 500 }),
    async () => new Response('<html>Gateway UI</html>'),
    async () => { throw new Error('ECONNREFUSED'); }]) {
    await assert.rejects(selectA2A({ execute: inventory(['a2a']), fetcher }));
  }
  for (const execute of [async () => { throw new Error('CLI unavailable'); },
    async () => ({ stdout: '{}' }), async () => ({ stdout: '{broken' })]) {
    await assert.rejects(selectA2A({ execute, fetcher: neverFetch }));
  }
  await assert.rejects(selectA2A({ execute: inventory([]), hostConfig: { channels: { a2a: { enabled: false } } },
    fetcher: async () => new Response('', { status: 404 }) }), /native A2A/);
});

test('explicit A2A origin is validated and never replaced by compatibility', async () => {
  const origin = 'http://127.0.0.1:9901';
  const execute = () => { throw new Error('Explicit origins do not need host CLI detection'); };
  assert.deepEqual(await selectA2A({ config: { local: origin }, execute, fetcher: async () => card(origin) }),
    { mode: 'existing', local: origin });
  await assert.rejects(selectA2A({ config: { local: origin }, execute,
    fetcher: async () => new Response('', { status: 404 }) }), /no Agent Card/);
  await assert.rejects(selectA2A({ config: { local: `${origin}/a2a/v1` }, execute }), /origin/);
});

test('native discovery may advertise a public URL, but auth probes stay on the local Gateway', async () => {
  let posts = 0;
  const fetcher = async (url, options) => {
    if (options.method !== 'POST') return card('https://public-openclaw.example');
    posts++;
    assert.equal(url, 'http://127.0.0.1:18789/a2a/v1');
    assert.equal(JSON.parse(options.body).method, 'GetTask');
    return nativeResponse(url, options);
  };
  assert.equal((await selectA2A({ execute: inventory(['a2a']), token, fetcher })).mode, 'native');
  assert.equal(posts, 1);
  await assert.rejects(selectA2A({ execute: inventory(['a2a']), fetcher }), /peer bearer token/);
  for (const response of [() => new Response('', { status: 401 }),
    () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'connector-auth-probe', error: { code: -32601 } }))]) {
    await assert.rejects(selectA2A({ execute: inventory(['a2a']), token,
      fetcher: async (url, options) => options.method === 'POST' ? response() : card(new URL(url).origin) }));
  }
});

test('installer includes compatibility code only when the host lacks A2A, before any mutation', async () => {
  for (const native of [true, false]) {
    let staged, installs = 0;
    await installOpenClaw({ token, execute: async (binary, args) => {
      if (args.includes('list')) return inventory(native ? ['a2a'] : [])();
      if (binary === 'npm') {
        staged = args.at(-1);
        assert.ok(args.includes('--omit=peer'));
        const pkg = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
        assert.equal(pkg.peerDependenciesMeta.openclaw.optional, true);
        if (native) await assert.rejects(access(join(staged, 'adapter-server.js')), { code: 'ENOENT' });
        else { await access(join(staged, 'adapter-server.js')); await access(join(staged, 'agent-driver.js')); }
        await access(join(staged, 'vendor/connector/cli.js'));
      } else {
        assert.deepEqual(args, ['plugins', 'install', staged]); installs++;
      }
      return { stdout: '' };
    }, fetcher: async (url, options) => nativeResponse(url, options) });
    assert.equal(installs, 1);
    await assert.rejects(access(staged), { code: 'ENOENT' });
  }
  let mutations = 0;
  await assert.rejects(installOpenClaw({ execute: async (_binary, args) => {
    if (args.includes('list')) return inventory(['a2a'])();
    mutations++; return { stdout: '' };
  }, fetcher: async () => new Response('', { status: 401 }) }));
  assert.equal(mutations, 0);
});

test('CLI driver uses isolated sessions and supports legacy/new reply envelopes; errors fail closed', async () => {
  const calls = [], values = [
    { status: 'ok', result: { payloads: [{ text: 'first' }] } },
    { payloads: [{ text: 'second' }] }, { ok: true, status: 'ok', payloads: [{ text: 'other' }] },
    { status: 'error', result: { payloads: [{ text: 'failure' }] } },
    { status: 'ok', result: { payloads: [] } }, { payloads: [{ isError: true, text: 'bad' }] },
  ];
  const create = createAgentDriver({ agent: 'reviewer', binary: '/host/openclaw', args: ['--profile', 'private'],
    execute: async (...args) => { calls.push(args); return { stdout: JSON.stringify(values.shift()) }; } });
  const one = create(), two = create();
  assert.equal(await one.run('a'), 'first');
  assert.equal(await one.run('b'), 'second');
  assert.equal(await two.run('c'), 'other');
  const session = call => call[1][call[1].indexOf('--session-id') + 1];
  assert.equal(session(calls[0]), session(calls[1]));
  assert.notEqual(session(calls[0]), session(calls[2]));
  assert.equal(calls[0][0], '/host/openclaw');
  assert.deepEqual(calls[0][1].slice(0, 5), ['--profile', 'private', 'agent', '--agent', 'reviewer']);
  assert.ok(!calls[0][1].includes('--deliver'));
  for (let i = 0; i < 3; i++) await assert.rejects(one.run('error'));
});

async function adapterFixture(t, createSession) {
  const adapter = createAdapterServer({ token, createSession });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  t.after(() => adapter.close());
  const origin = `http://127.0.0.1:${adapter.server.address().port}`;
  const rpc = async (method, params) => (await fetch(`${origin}/a2a/v1`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const send = (text, contextId, messageId = randomUUID(), blocking = false) => rpc('SendMessage', {
    message: { messageId, role: 'ROLE_USER', parts: [{ text }], ...(contextId ? { contextId } : {}) },
    configuration: { blocking } });
  const settled = async id => {
    for (let i = 0; i < 100; i++) {
      const { result } = await rpc('GetTask', { id });
      if (result.status.state !== 'TASK_STATE_WORKING') return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Task did not settle');
  };
  return { adapter, origin, rpc, send, settled };
}

test('compatibility A2A authenticates, polls real output, continues and isolates contexts', async t => {
  const f = await adapterFixture(t, () => {
    const history = [];
    return { run: async text => { history.push(text); return history.join('|'); } };
  });
  assert.equal((await fetch(`${f.origin}/.well-known/agent-card.json`)).status, 401);
  assert.equal((await fetch(`${f.origin}/a2a/v1`, { method: 'POST' })).status, 401);
  const discovery = await (await fetch(`${f.origin}/.well-known/agent-card.json`, {
    headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(discovery.supportedInterfaces[0].url, `${f.origin}/a2a/v1`);
  const first = (await f.send('apple')).result.task;
  assert.equal((await f.settled(first.id)).artifacts[0].parts[0].text, 'apple');
  const continuation = (await f.send('recall', first.contextId, 'turn2', true)).result.task;
  assert.equal(continuation.artifacts[0].parts[0].text, 'apple|recall');
  assert.equal((await f.send('recall', first.contextId, 'turn2')).result.task.id, continuation.id);
  assert.ok((await f.send('changed', first.contextId, 'turn2')).error);
  assert.equal((await f.send('alone', undefined, 'other', true)).result.task.artifacts[0].parts[0].text, 'alone');
  assert.ok((await f.send('bad', 'unknown')).error);
  assert.ok((await f.rpc('SendMessage', { message: { messageId: 'bad', role: 'ROLE_USER', parts: [{ data: {} }] } })).error);
});

test('busy contexts reject overlap and adapter never claims unconfirmed cancellation', async t => {
  let finish;
  const f = await adapterFixture(t, () => ({ run: () => new Promise(resolve => { finish = resolve; }) }));
  const first = (await f.send('slow')).result.task;
  assert.ok((await f.send('overlap', first.contextId)).error);
  assert.equal((await f.rpc('CancelTask', { id: first.id })).error.code, -32004);
  assert.equal((await f.rpc('GetTask', { id: first.id })).result.status.state, 'TASK_STATE_WORKING');
  finish('actual response');
  assert.equal((await f.settled(first.id)).status.state, 'TASK_STATE_COMPLETED');
});

test('failed CLI output becomes a failed A2A task', async t => {
  const f = await adapterFixture(t, () => ({ run: async () => { throw new Error('private diagnostic'); } }));
  const first = (await f.send('fail')).result.task;
  const task = await f.settled(first.id);
  assert.equal(task.status.state, 'TASK_STATE_FAILED');
  assert.equal(task.artifacts.length, 0);
  assert.doesNotMatch(task.status.message.parts[0].text, /private diagnostic/);
});

test('compatibility adapter selects the next available loopback port', async t => {
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const adapter = createAdapterServer({ token, createSession: () => ({}) });
  t.after(() => adapter.close());
  const start = occupied.address().port;
  const port = await listenAdapter(adapter.server, start);
  assert.ok(port > start && port < start + 20);
});

test('legacy plugin service serves A2A through the actual Connector and host CLI', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'openclaw');
  await writeFile(binary, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif(args[0] === 'plugins') console.log(JSON.stringify({plugins: []}));\nelse console.log(JSON.stringify({status:'ok',result:{payloads:[{text:'host:'+args[args.indexOf('--message')+1]}]}}));\n`);
  await chmod(binary, 0o700);
  const state = join(dir, 'state.json');
  await writeFile(state, JSON.stringify({ agentId: 'openclaw-test', token }), { mode: 0o600 });
  const relay = createServer();
  const ws = new WebSocketServer({ server: relay });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of ws.clients) socket.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => relay.close(resolve)); });
  let service, tool;
  plugin.register({ config: {}, pluginConfig: { relay: `ws://127.0.0.1:${relay.address().port}/connect`,
    allowInsecure: true, state, openclawBinary: binary },
  registerService: value => { service = value; }, registerTool: value => { tool = value; } });
  assert.equal(tool.name, 'a2a_connector_pair');
  const connected = new Promise(resolve => ws.once('connection', resolve));
  t.after(() => service.stop());
  await service.start();
  const socket = await connected;
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
  const discovery = await forward('GET', '/.well-known/agent-card.json');
  assert.equal(discovery.name, 'OpenClaw main');
  const response = await forward('POST', '/a2a/v1', { jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: { message: { role: 'ROLE_USER', messageId: 'integration', parts: [{ text: 'hello' }] },
      configuration: { blocking: true } } });
  assert.equal(response.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(response.result.task.artifacts[0].parts[0].text, 'host:hello');
});
