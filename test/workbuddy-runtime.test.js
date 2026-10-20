import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveEnrollment } from '../src/connector.js';

const run = promisify(execFile);
const cli = process.env.A2A_TEST_WORKBUDDY_CLI || 'plugins/workbuddy/cli.js';
async function waitRead(path) {
  for (let i = 0; i < 100; i++) {
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for state file');
}

for (const mode of ['desktop', 'cloud']) test(`${mode} setup pairs without an external origin; GUI auth is noninteractive and stop releases locks`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-runtime-'));
  const env = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory };
  let requests = 0;
  const relay = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pairing/requests') {
      requests++;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.equal(JSON.parse(raw).name, 'WorkBuddy Test');
      res.writeHead(201);
      res.end(JSON.stringify({ requestId: '1'.repeat(64), agentId: 'workbuddy-test', confirmationCode: '123ABC' }));
    } else if (req.url === '/pairing/status') res.end(JSON.stringify({ status: 'pending' }));
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await run(process.execPath, [cli, 'stop'], { env, timeout: 10000 }).catch(() => {});
    await new Promise(resolve => relay.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${relay.address().port}/connect`;
  const setup = await run(process.execPath, [cli, 'setup', '--relay', url, '--mode', mode,
    ...(mode === 'cloud' ? ['--task-id', 'existing'] : []), '--name', 'WorkBuddy Test', '--allow-insecure'], { env, timeout: 10000 });
  assert.match(setup.stdout, new RegExp(`${mode} adapter started`));
  const savedSettings = JSON.parse(await readFile(join(directory, 'workbuddy-settings.json'), 'utf8'));
  assert.equal(savedSettings.adapter, mode);
  if (mode === 'cloud') assert.equal(savedSettings.cloudTaskId, 'existing');
  const pending = JSON.parse(await waitRead(join(directory, 'workbuddy.json.pending')));
  assert.equal(pending.confirmationCode, '123ABC');
  const firstPid = await readFile(join(directory, 'workbuddy.pid'), 'utf8');
  const auth = await run(process.execPath, [cli, 'auth', 'connect'], { env, timeout: 10000 });
  assert.match(auth.stdout, /http:\/\/127\.0\.0\.1:\d+\/pair/);
  assert.equal(await readFile(join(directory, 'workbuddy.pid'), 'utf8'), firstPid);
  assert.equal(requests, 1);
  const status = await run(process.execPath, [cli, 'auth', 'status'], { env });
  assert.match(status.stdout, /Awaiting approval/);
  await assert.rejects(run(process.execPath, [cli, 'start'], { env }), /already running/);
  await run(process.execPath, [cli, 'stop'], { env, timeout: 10000 });
  await assert.rejects(readFile(join(directory, 'workbuddy.pid')), { code: 'ENOENT' });
});

function inputRun(args, text, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(text);
  });
}

test('outbound CLI saves its request before dispatch and recovers timeout without sending again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-outbound-'));
  const env = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory };
  let sends = 0, requestId;
  const relay = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer paired');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/agents/worker/.well-known/agent-card.json') {
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `http://127.0.0.1:${relay.address().port}/agents/worker/rpc` }] }));
    } else if (req.url === '/agents/worker/rpc') {
      sends++;
      requestId = req.headers['x-relay-request-id'];
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.equal(JSON.parse(raw).params.message.messageId, 'stable-request');
      const saved = JSON.parse(await readFile(join(directory, 'workbuddy.json.outbound.json'), 'utf8'));
      assert.equal(saved.tasks[0].id, requestId);
      res.writeHead(504);
      res.end(JSON.stringify({ error: 'agent_timeout' }));
    } else if (req.url === `/relay/requests/${requestId}`) {
      res.end(JSON.stringify({ targetAgentId: 'worker', state: 'completed', responseBody: JSON.stringify({ jsonrpc: '2.0', id: 1,
        result: { message: { parts: [{ text: 'late verified result' }] } } }) }));
    } else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => relay.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await saveEnrollment(join(directory, 'workbuddy.json'), { agentId: 'workbuddy', token: 'paired' });
  await writeFile(join(directory, 'workbuddy-settings.json'), JSON.stringify({ relay: `ws://127.0.0.1:${relay.address().port}/connect`, allowInsecure: true }));
  const first = await inputRun(['call', 'worker', '--message-id', 'stable-request'], 'do work', env);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /Query workbuddy-a2a outbound/);
  assert.equal(sends, 1);
  const recovered = await inputRun(['call', 'worker', '--message-id', 'stable-request'], 'do work', env);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).text, 'late verified result');
  assert.equal(sends, 1);
  const changed = await inputRun(['call', 'worker', '--message-id', 'stable-request'], 'different work', env);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /different task content/);
  assert.equal(sends, 1);
});

test('stop never signals a reused PID identified by a stale managed owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-reused-pid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory };
  await writeFile(join(directory, 'workbuddy-settings.json'), JSON.stringify({ adapter: 'desktop' }));
  await writeFile(join(directory, 'workbuddy.pid'), String(process.pid));
  await mkdir(join(directory, 'workbuddy.json.runner.lock'));
  await writeFile(join(directory, 'workbuddy.json.runner.lock', 'owner.json'), JSON.stringify({ pid: process.pid,
    hostname: hostname(), processIdentity: 'prior-process-birth', instanceId: 'old-runner' }));
  await run(process.execPath, [cli, 'stop'], { env });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  await assert.rejects(readFile(join(directory, 'workbuddy.pid')), { code: 'ENOENT' });
});

test('an explicit preflight failure can be corrected without creating a duplicate dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-preflight-'));
  const env = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory };
  let allowed = false, sends = 0;
  const relay = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/agent-card.json')) {
      if (!allowed) { res.writeHead(403); res.end('{}'); return; }
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC',
        url: `http://127.0.0.1:${relay.address().port}/agents/worker/rpc` }] }));
    } else {
      sends++;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.equal(JSON.parse(raw).params.message.messageId, 'preflight-request');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { message: { parts: [{ text: 'done' }] } } }));
    }
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => relay.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await saveEnrollment(join(directory, 'workbuddy.json'), { agentId: 'workbuddy', token: 'paired' });
  await writeFile(join(directory, 'workbuddy-settings.json'), JSON.stringify({ relay: `ws://127.0.0.1:${relay.address().port}/connect`, allowInsecure: true }));
  const first = await inputRun(['call', 'worker', '--message-id', 'preflight-request'], 'work', env);
  assert.equal(first.code, 1);
  const record = JSON.parse(await readFile(join(directory, 'workbuddy.json.outbound.json'), 'utf8')).tasks[0];
  assert.equal(record.dispatchState, 'not-sent');
  assert.equal(sends, 0);
  allowed = true;
  const second = await inputRun(['call', 'worker', '--message-id', 'preflight-request'], 'work', env);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).text, 'done');
  assert.equal(sends, 1);
});
