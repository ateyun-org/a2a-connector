import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopAPI } from './desktop-api.js';
import { DesktopBridge } from './desktop-bridge.js';
import { CloudAPI } from './cloud-api.js';
import { CloudBridge } from './cloud-bridge.js';
import { HybridBridge } from './hybrid-bridge.js';
import { TaskStore } from './task-store.js';
import { createWorkBuddyAdapter } from './adapter-server.js';
import { platformAccessToken } from './platform-client.js';
import { loadEnrollment, validateConfig } from './vendor/connector/connector.js';
import { acquireStateLock } from './vendor/connector/state-lock.js';
import { createProcessSupervisor } from './vendor/connector/process-supervisor.js';

/** Shared server runtime: no WorkBuddy executable, local desktop origin, or client secret. */
export async function startReceiver(c, state, { apiFactory } = {}) {
  if (!['desktop', 'cloud', 'hybrid'].includes(c.adapter)) throw new Error('Unsupported WorkBuddy adapter');
  validateConfig({ ...c, local: 'http://127.0.0.1', token: 'pending' });
  if (c.agentId && !/^[A-Za-z0-9_-]{1,64}$/.test(c.agentId)) throw new Error('Invalid WorkBuddy Agent ID');
  const lock = await acquireStateLock(state + '.runner');
  let adapter, supervisor, closed = false, bridge;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await supervisor?.stop(); }
    finally {
      try { if (adapter) await adapter.close(); else await bridge?.close(); }
      finally { await lock.release(); }
    }
  };
  try {
    if (c.agentId) {
      try {
        if ((await loadEnrollment(state)).agentId !== c.agentId) throw new Error('Stored WorkBuddy identity does not match receiver');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const accessToken = async () => {
      const enrollment = await loadEnrollment(state);
      if (c.agentId && enrollment.agentId !== c.agentId) throw new Error('Stored WorkBuddy identity does not match receiver');
      return platformAccessToken({ relay: c.relay, allowInsecure: !!c.allowInsecure, enrollment });
    };
    const make = mode => {
      const api = apiFactory ? apiFactory(mode, accessToken) : new (mode === 'cloud' ? CloudAPI : DesktopAPI)({ accessToken });
      const store = new TaskStore(state + (c.adapter === 'hybrid' && mode === 'desktop' ? '.desktop.tasks.json' : '.tasks.json'));
      return mode === 'cloud' ? new CloudBridge({ api, store, taskId: c.cloudTaskId, cwd: c.cwd }) : new DesktopBridge({ api, store });
    };
    bridge = c.adapter === 'hybrid' ? new HybridBridge({ cloud: make('cloud'), desktop: make('desktop'), defaultMode: c.defaultMode }) : make(c.adapter);
    await bridge.start();
    const localToken = randomBytes(32).toString('hex');
    adapter = createWorkBuddyAdapter({ token: localToken, bridge, name: c.name || 'WorkBuddy' });
    await new Promise((resolve, reject) => { adapter.server.once('error', reject); adapter.server.listen(0, '127.0.0.1', resolve); });
    const local = `http://127.0.0.1:${adapter.server.address().port}`;
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
    supervisor = createProcessSupervisor({ launch: () => {
      const child = spawn(process.env.A2A_NODE_BINARY || process.execPath,
        [cli, '-relay', c.relay, '-local', local, '-state', state,
          ...(c.agentId ? ['-agent-id', c.agentId] : []), ...(c.allowInsecure ? ['-allow-insecure'] : [])],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, A2A_LOCAL_TOKEN: localToken } });
      child.stdout.on('data', chunk => process.stdout.write(chunk));
      child.stderr.on('data', chunk => process.stderr.write(chunk));
      return child;
    }, onError: () => console.error('WorkBuddy tunnel process could not start') });
    supervisor.start();
    return { local, bridge, close };
  } catch (error) { await close(); throw error; }
}
