import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createProcessSupervisor } from '../src/process-supervisor.js';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Supervisor did not reach expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('supervisor restarts a failed child, resets run logs, and stops gracefully via IPC', async t => {
  let launches = 0;
  const supervisor = createProcessSupervisor({ minDelayMs: 20, maxDelayMs: 40,
    launch: () => spawn(process.execPath, ['-e', ++launches === 1
      ? "console.log('old-offline'); process.exitCode=7;"
      : "console.log('new-online'); process.on('message',()=>process.exit(0)); setInterval(()=>{},1000);"],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }) });
  t.after(() => supervisor.stop());
  supervisor.start(); supervisor.start();
  await until(() => supervisor.status().recentLogs.includes('new-online'));
  assert.equal(launches, 2);
  assert.doesNotMatch(supervisor.status().recentLogs, /old-offline/);
  assert.equal(supervisor.status().logsAreHistorical, true);
  assert.ok(supervisor.status().logRun.startedAt);
  await supervisor.stop();
  assert.equal(supervisor.status().logRun.exitCode, 0);
  assert.ok(supervisor.status().logRun.endedAt);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(launches, 2);
});

test('stopping during backoff cancels all retries, including spawn errors', async t => {
  let launches = 0;
  const supervisor = createProcessSupervisor({ minDelayMs: 100, maxDelayMs: 200,
    launch: () => { launches++; return spawn('/missing/a2a-node', []); } });
  t.after(() => supervisor.stop());
  supervisor.start();
  await until(() => supervisor.status().restartScheduled);
  assert.ok(supervisor.status().logRun.retryAt);
  await supervisor.stop();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(launches, 1);
  assert.equal(supervisor.status().restartScheduled, false);
});

test('permanent pairing/configuration failures do not trigger automatic redemption retries', async t => {
  let launches = 0;
  const supervisor = createProcessSupervisor({ minDelayMs: 10,
    launch: () => { launches++; return spawn(process.execPath, ['-e', 'process.exit(78)']); } });
  t.after(() => supervisor.stop());
  supervisor.start();
  await until(() => supervisor.status().logRun?.restartBlocked);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(launches, 1);
  assert.equal(supervisor.status().restartScheduled, false);
});
