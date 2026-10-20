import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveEnrollment } from '../src/connector.js';
import { acquireStateLock } from '../src/state-lock.js';

const run = promisify(execFile);
const cli = process.env.A2A_TEST_WORKBUDDY_CLI || 'plugins/workbuddy/cli.js';

for (const mode of ['desktop', 'cloud']) test(`${mode} GUI connection requires account authorization and provides mode-specific setup`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-onboarding-'));
  const state = join(directory, 'workbuddy.json');
  const env = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory, A2A_CONNECTOR_INSTANCE: 'default' };
  let starts = 0, otherRequests = 0;
  const relay = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-onboarding-credential');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/workbuddy/status') res.end(JSON.stringify({ linked: false }));
    else if (req.url === '/oauth/workbuddy/start' && req.method === 'POST') {
      starts++;
      res.writeHead(201);
      res.end(JSON.stringify({ authorizationURL: 'https://www.workbuddy.cn/openapi/v2/authorize?state=' + 'f'.repeat(64) }));
    } else { otherRequests++; res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const owner = await acquireStateLock(state);
  const runner = await acquireStateLock(state + '.runner');
  t.after(async () => {
    await owner.release(); await runner.release();
    await new Promise(resolve => relay.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await saveEnrollment(state, { agentId: 'workbuddy-test', token: 'private-onboarding-credential' });
  await writeFile(join(directory, 'workbuddy-settings.json'), JSON.stringify({ adapter: mode,
    relay: `ws://127.0.0.1:${relay.address().port}/connect`, allowInsecure: true }));
  await writeFile(join(directory, 'workbuddy.pid'), String(process.pid));
  await writeFile(state + '.status.json', JSON.stringify({ instanceId: owner.owner.instanceId,
    tunnelOnline: true, updatedAt: new Date().toISOString() }));
  const paired = await run(process.execPath, [cli, 'auth', 'status'], { env });
  assert.match(paired.stdout, /Logged in/);
  await assert.rejects(run(process.execPath, [cli, 'connection', 'status'], { env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /账号授权/);
    assert.doesNotMatch(error.stdout, /Logged in/);
    assert.equal(error.stdout.includes('允许移动端连接此设备'), mode === 'desktop');
    return true;
  });
  await assert.rejects(run(process.execPath, [cli, 'doctor'], { env }), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.paired, true);
    assert.equal(result.tunnelOnline, true);
    assert.equal(result.linked, false);
    assert.equal(result.connectionReady, false);
    assert.ok(result.nextActions.some(action => action.action === 'authorize'));
    assert.equal(result.nextActions.some(action => action.action === 'confirm_desktop_control'), mode === 'desktop');
    return true;
  });
  assert.equal(starts, 0, 'status checks must not initiate OAuth');
  const connected = await run(process.execPath, [cli, 'auth', 'connect'], { env });
  assert.match(connected.stdout, /oauth\/workbuddy\/setup\?state=f{64}&mode=/);
  assert.ok(connected.stdout.includes(`mode=${mode}`));
  assert.equal(connected.stdout.includes('允许移动端连接此设备'), mode === 'desktop');
  assert.doesNotMatch(connected.stdout, /private-onboarding-credential/);
  assert.equal(starts, 1);
  assert.equal(otherRequests, 0, 'onboarding must not send a task or retrieve an upstream token');
});
