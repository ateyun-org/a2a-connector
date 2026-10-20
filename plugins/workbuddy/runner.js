#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopAPI } from './desktop-api.js';
import { DesktopBridge } from './desktop-bridge.js';
import { CloudAPI } from './cloud-api.js';
import { CloudBridge } from './cloud-bridge.js';
import { TaskStore } from './task-store.js';
import { createWorkBuddyAdapter } from './adapter-server.js';
import { platformAccessToken } from './platform-client.js';
import { loadEnrollment, validateConfig } from './vendor/connector/connector.js';
import { acquireStateLock } from './vendor/connector/state-lock.js';
import { createProcessSupervisor } from './vendor/connector/process-supervisor.js';

async function main() {
  const [settingsPath, state] = process.argv.slice(2);
  if (!settingsPath || !state) throw new Error('WorkBuddy runner requires settings and state paths');
  const c = JSON.parse(await readFile(settingsPath, 'utf8'));
  if (!['desktop', 'cloud'].includes(c.adapter)) throw new Error('WorkBuddy runner requires a supported adapter');
  validateConfig({ ...c, local: 'http://127.0.0.1', token: 'pending' });
  const lock = await acquireStateLock(state + '.runner');
  let adapter, supervisor;
  const stopped = new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  process.title = `workbuddy-a2a-${createHash('sha256').update(state).digest('hex').slice(0, 8)}`;
  try {
    const api = new (c.adapter === 'cloud' ? CloudAPI : DesktopAPI)({ accessToken: async () => platformAccessToken({ relay: c.relay,
      allowInsecure: !!c.allowInsecure, enrollment: await loadEnrollment(state) }) });
    const bridge = c.adapter === 'cloud' ? new CloudBridge({ api, store: new TaskStore(state + '.tasks.json'),
      taskId: c.cloudTaskId, cwd: c.cwd }) : new DesktopBridge({ api, store: new TaskStore(state + '.tasks.json') });
    await bridge.start();
    const localToken = randomBytes(32).toString('hex');
    adapter = createWorkBuddyAdapter({ token: localToken, bridge, name: c.name || `WorkBuddy ${c.adapter}` });
    await new Promise((resolve, reject) => {
      adapter.server.once('error', reject);
      adapter.server.listen(0, '127.0.0.1', resolve);
    });
    const local = `http://127.0.0.1:${adapter.server.address().port}`;
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
    supervisor = createProcessSupervisor({ launch: () => {
      const child = spawn(process.env.A2A_NODE_BINARY || process.execPath,
      [cli, '-relay', c.relay, '-local', local, '-state', state, '-auto-pair',
        ...(c.agentId ? ['-agent-id', c.agentId] : []), ...(c.allowInsecure ? ['-allow-insecure'] : [])], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, A2A_LOCAL_TOKEN: localToken },
      });
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      return child;
    }, onError: () => console.error('WorkBuddy tunnel process could not start') });
    // Logs contain only Connector diagnostics; OAuth credentials remain in the token provider.
    supervisor.start();
    console.log(`WorkBuddy ${c.adapter} adapter listening on ${local}; waiting for pairing and OAuth authorization`);
    if (process.send) process.send({ type: 'workbuddy_ready', local });
    await stopped;
  } finally {
    await supervisor?.stop();
    await adapter?.close();
    await lock.release();
  }
}

main().catch(() => {
  console.error('WorkBuddy runner failed; check settings, journal permissions, and dependency installation');
  if (process.send) process.send({ type: 'workbuddy_start_failed' }, () => process.exit(78));
  else process.exit(78);
});
