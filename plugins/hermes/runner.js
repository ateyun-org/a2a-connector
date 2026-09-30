import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { saveEnrollment } from './vendor/connector/connector.js';
import { acquireStateLock, canonicalState } from './vendor/connector/state-lock.js';

const root = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);

function tokenFrom(env) {
  if (env.A2A_LOCAL_TOKEN || env.A2A_BEARER_TOKEN) return env.A2A_LOCAL_TOKEN || env.A2A_BEARER_TOKEN;
  for (const item of (env.A2A_PEER_TOKENS || '').split(',')) {
    const split = item.indexOf(':');
    if (split > 0 && item.slice(0, split).trim() === 'connector') return item.slice(split + 1).trim();
  }
  return '';
}

async function activeRuntime(state) {
  try {
    const path = state + '.a2a-runtime.json';
    const info = await stat(path);
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Hermes runtime file must be private (0600)');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isInteger(value.pid) || value.pid <= 1 || typeof value.local !== 'string') throw new Error('Invalid Hermes A2A runtime file');
    process.kill(value.pid, 0);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

export async function prepareHermesA2A({ state, short = false, env = process.env, run = execute } = {}) {
  if (short) {
    const active = await activeRuntime(state);
    if (active) return { ...active, token: active.token || tokenFrom(env), close: async () => {} };
  }
  const { stdout } = await run(env.A2A_HERMES_PYTHON || 'python3', [join(root, 'a2a_support.py')],
    { env, timeout: 20000, maxBuffer: 1024 * 1024 });
  const selected = JSON.parse(stdout);
  if (!['native', 'existing', 'compat'].includes(selected.mode)) throw new Error('Invalid Hermes A2A capability result');
  if (selected.mode !== 'compat') return { ...selected, token: tokenFrom(env), close: async () => {} };
  let createAdapterServer, listenAdapter, createHermesDriver;
  try {
    ({ createAdapterServer, listenAdapter } = await import('./adapter-server.js'));
    ({ createHermesDriver } = await import('./agent-driver.js'));
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('Hermes was downgraded: rerun install-hermes.py to install compatibility A2A');
    throw error;
  }
  const token = randomBytes(32).toString('hex');
  const driver = createHermesDriver({ python: env.A2A_HERMES_PYTHON || 'python3', binary: env.A2A_HERMES_BINARY,
    timeoutMs: Number(env.A2A_TASK_TIMEOUT_MS || 600000), env });
  const adapter = createAdapterServer({ token, name: env.A2A_AGENT_NAME || 'Hermes Agent', createSession: driver });
  try {
    const port = await listenAdapter(adapter.server, Number(env.A2A_COMPAT_PORT || 9900), Number(env.A2A_COMPAT_PORT_ATTEMPTS || 20));
    return { mode: 'compat', local: `http://127.0.0.1:${port}`, token,
      close: async () => { driver.close(); await adapter.close(); } };
  } catch (error) { driver.close(); await adapter.close(); throw error; }
}

export async function runHermesConnector(args, { env = process.env } = {}) {
  const originIndex = args.indexOf('-local');
  env = { ...env, A2A_LOCAL_URL: originIndex < 0 ? env.A2A_LOCAL_URL : args[originIndex + 1] };
  const index = args.indexOf('-state');
  if (index < 0 || !args[index + 1]) throw new Error('Hermes runner requires -state');
  const state = await canonicalState(args[index + 1]);
  args = [...args]; args[index + 1] = state;
  const short = args.includes('-request-only') || args.includes('-enroll-only') || args.includes('-status');
  let prepared, child, timer, lock;
  let stopped = false;
  const stop = () => {
    stopped = true;
    child?.kill('SIGTERM');
    timer ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    // Separate from the child's Connector lock: exclude competing wrappers before
    // binding adapters or writing the shared private runtime record.
    if (!short) lock = await acquireStateLock(state + '.hermes-runner');
    if (!args.includes('-status')) prepared = await prepareHermesA2A({ state, short, env });
    if (stopped) return 0;
    const forwarded = [...args];
    if (prepared) {
      const local = forwarded.indexOf('-local');
      if (local < 0) forwarded.push('-local', prepared.local);
      else forwarded[local + 1] = prepared.local;
      if (!short) {
        const active = await activeRuntime(state);
        if (active) throw new Error('Another Hermes Connector owns this state; stop it before starting again');
        await saveEnrollment(state + '.a2a-runtime.json', { pid: process.pid, mode: prepared.mode,
          local: prepared.local, ...(prepared.mode === 'compat' ? { token: prepared.token } : {}) });
      }
      console.error(`Hermes Connector: ${prepared.mode} A2A at ${prepared.local}`);
    }
    const outcome = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [join(root, 'vendor/connector/cli.js'), ...forwarded], {
        stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, A2A_LOCAL_TOKEN: prepared?.token || '' },
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? (stopped ? 0 : 1) : code));
    });
    return outcome ?? 1;
  } finally {
    clearTimeout(timer);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try {
      await prepared?.close();
      if (!short) {
        try {
          const value = JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8'));
          if (value.pid === process.pid) await rm(state + '.a2a-runtime.json', { force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally { await lock?.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHermesConnector(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error(`Hermes Connector failed: ${error.message}`); process.exitCode = 1; });
}
