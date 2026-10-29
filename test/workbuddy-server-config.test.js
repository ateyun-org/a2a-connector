import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = resolve('../a2a-relay/scripts/workbuddy-config.py');

test('server setup creates private credentials once, detects missing configuration and never emits secrets', async t => {
  try { await access(script); } catch { t.skip('Sibling Relay checkout is required for server setup verification'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'workbuddy-private-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'server.env');
  const result = await run('python3', [script, 'init', '--env', path, '--client-id', 'test-app']);
  assert.equal(JSON.parse(result.stdout).mode, '0600');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const initial = await readFile(path, 'utf8');
  assert.match(initial, /WORKBUDDY_CLIENT_SECRET=\n/);
  await assert.rejects(run('python3', [script, 'check', '--env', path]), error => {
    const report = JSON.parse(error.stdout);
    assert.deepEqual(report.missing, ['WORKBUDDY_CLIENT_SECRET']);
    assert.equal(report.ready, false);
    return true;
  });
  await assert.rejects(run('python3', [script, 'init', '--env', path, '--client-id', 'other-app']));
  assert.equal(await readFile(path, 'utf8'), initial, 'init must never rotate an existing encryption key or credentials');
  await writeFile(path, initial.replace('WORKBUDDY_CLIENT_SECRET=\n', 'WORKBUDDY_CLIENT_SECRET=private-provider-secret\n'), { mode: 0o600 });
  const checked = await run('python3', [script, 'check', '--env', path]);
  assert.equal(JSON.parse(checked.stdout).ready, true);
  assert.doesNotMatch(checked.stdout + result.stdout, /private-provider-secret/);
  for (const field of ['RELAY_AGENT_TICKET_KEY', 'WORKBUDDY_TOKEN_KEY']) {
    const secret = new RegExp(`${field}=([^\n]+)`).exec(initial)[1];
    assert.ok(!checked.stdout.includes(secret) && !result.stdout.includes(secret));
  }
  await writeFile(path, initial.replace('user.task.readable ', '').replace('WORKBUDDY_CLIENT_SECRET=\n', 'WORKBUDDY_CLIENT_SECRET=private-provider-secret\n'));
  await assert.rejects(run('python3', [script, 'check', '--env', path]), error => {
    assert.ok(JSON.parse(error.stdout).invalid.includes('WORKBUDDY_SCOPES'));
    return true;
  });
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(run('python3', [script, 'check', '--env', path]));
  }
});
