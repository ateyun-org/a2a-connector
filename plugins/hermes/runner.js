import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat, rm } from 'node:fs/promises';
import { delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadEnrollment, loadPendingPairing, saveEnrollment } from './vendor/connector/connector.js';
import { acquireStateLock, canonicalState, connectorStatus, lockOwner } from './vendor/connector/state-lock.js';

const root = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);

async function runtimeEnvironment(env) {
  let hints = {};
  try { hints = JSON.parse(await readFile(join(root, 'host-runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...env,
    ...(hints.home && !env.HERMES_HOME ? { HERMES_HOME: hints.home } : {}),
    ...(hints.hermesRoot ? { PYTHONPATH: [hints.hermesRoot, env.PYTHONPATH].filter(Boolean).join(delimiter) } : {}),
    A2A_HERMES_PYTHON: env.A2A_HERMES_PYTHON || hints.python || (process.platform === 'win32' ? 'python' : 'python3') };
}

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
    if (!Number.isInteger(value.pid) || value.pid <= 1 || (value.mode && typeof value.local !== 'string')) throw new Error('Invalid Hermes A2A runtime file');
    process.kill(value.pid, 0);
    const owner = await lockOwner(state + '.hermes-runner');
    if (!owner || owner.pid !== value.pid || (value.instanceId && owner.instanceId !== value.instanceId)) {
      throw new Error('Hermes runtime ownership does not match its lock; inspect the state before recovery');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

async function status(state) {
  const runtime = await activeRuntime(state);
  const health = await connectorStatus(state);
  let enrollment, pending;
  try {
    enrollment = await loadEnrollment(state);
    if (typeof enrollment.agentId !== 'string' || typeof enrollment.token !== 'string') throw new Error('Invalid Connector credential identity');
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!enrollment) {
    try {
      pending = await loadPendingPairing(state + '.pending');
      if (!Number.isFinite(pending.expiresAt)) throw new Error('Invalid pending approval expiration');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { running: Boolean(runtime), pid: runtime?.pid, mode: runtime?.mode, local: runtime?.local,
    controllable: Boolean(runtime?.instanceId), phase: runtime?.phase || 'stopped',
    paired: Boolean(enrollment?.agentId && enrollment?.token), agentId: enrollment?.agentId || pending?.agentId,
    tunnelOnline: Boolean(runtime && health.tunnelOnline), lastConnectedAt: health.lastConnectedAt,
    lastError: health.lastError, diagnostic: health.diagnostic,
    ...(pending ? { pairing: { status: 'pending', agentId: pending.agentId,
      confirmationCode: pending.confirmationCode, expiresAt: pending.expiresAt } } : {}) };
}

async function stopRuntime(state) {
  const runtime = await activeRuntime(state);
  if (!runtime) {
    const owner = await lockOwner(state + '.hermes-runner');
    if (owner) throw new Error(`Stale Hermes runner lock (PID ${owner.pid}); inspect it before recovery`);
    const cli = await lockOwner(state);
    if (cli) throw new Error(`Unmanaged or stale Connector CLI lock (PID ${cli.pid}); inspect its process tree before recovery`);
    let marker;
    try { marker = await readFile(state.slice(0, state.length - extname(state).length) + '.pid', 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker !== undefined) {
      const pid = Number(marker.trim());
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid legacy PID marker; inspect it before recovery');
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') return { stopped: true }; throw error; }
      throw new Error(`Legacy PID marker ${pid} is live without a managed owner; verify its process tree before upgrading`);
    }
    return { stopped: true };
  }
  if (!runtime.instanceId) throw new Error('Legacy Hermes runner cannot receive a managed stop; verify and stop its process tree before upgrading');
  await saveEnrollment(state + '.hermes-stop.json', { pid: runtime.pid, instanceId: runtime.instanceId });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const owner = await lockOwner(state + '.hermes-runner');
    if (!owner || owner.instanceId !== runtime.instanceId) return { stopped: true };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Hermes Connector did not finish stopping; inspect its private log and process tree');
}

export async function prepareHermesA2A({ state, short = false, env = process.env, run = execute } = {}) {
  if (short) {
    const active = await activeRuntime(state);
    if (active?.local) return { ...active, token: active.token || tokenFrom(env), close: async () => {} };
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
  env = await runtimeEnvironment(env);
  const originIndex = args.indexOf('-local');
  env = { ...env, A2A_LOCAL_URL: originIndex < 0 ? env.A2A_LOCAL_URL : args[originIndex + 1] };
  const index = args.indexOf('-state');
  if (index < 0 || !args[index + 1]) throw new Error('Hermes runner requires -state');
  const state = await canonicalState(args[index + 1]);
  args = [...args]; args[index + 1] = state;
  if (args.includes('-status')) { console.log(JSON.stringify(await status(state))); return 0; }
  if (args.includes('-stop')) { console.log(JSON.stringify(await stopRuntime(state))); return 0; }
  const short = args.includes('-request-only') || args.includes('-enroll-only') || args.includes('-status');
  let prepared, child, timer, lock, watcher, runtime;
  const startup = new AbortController();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    startup.abort();
    if (child?.connected) child.send({ type: 'hermes_shutdown' }, () => {});
    else child?.kill('SIGTERM');
    timer ??= setTimeout(() => child?.kill('SIGKILL'), 10000);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    // Separate from the child's Connector lock: exclude competing wrappers before
    // binding adapters or writing the shared private runtime record.
    if (!short) {
      if (process.platform === 'win32') await execute(env.A2A_HERMES_PYTHON,
        [join(root, 'host_support.py'), '--secure-state', state], { env, windowsHide: true });
      lock = await acquireStateLock(state + '.hermes-runner');
      runtime = { pid: process.pid, instanceId: lock.owner.instanceId, phase: 'starting' };
      await saveEnrollment(state + '.a2a-runtime.json', runtime);
      let inspectingStop = false;
      watcher = setInterval(async () => {
        if (inspectingStop) return;
        inspectingStop = true;
        try {
          const request = JSON.parse(await readFile(state + '.hermes-stop.json', 'utf8'));
          if (request.instanceId === runtime.instanceId && request.pid === process.pid) stop();
        } catch (error) { if (error.code !== 'ENOENT') console.error(`Hermes stop request: ${error.message}`); }
        finally { inspectingStop = false; }
      }, 100);
      watcher.unref();
    }
    prepared = await prepareHermesA2A({ state, short, env,
      run: (binary, argv, options) => execute(binary, argv, { ...options, signal: startup.signal, windowsHide: true }) });
    if (stopped) return 0;
    const forwarded = [...args];
    if (prepared) {
      const local = forwarded.indexOf('-local');
      if (local < 0) forwarded.push('-local', prepared.local);
      else forwarded[local + 1] = prepared.local;
      if (!short) {
        runtime = { ...runtime, phase: 'running', mode: prepared.mode,
          local: prepared.local, ...(prepared.mode === 'compat' ? { token: prepared.token } : {}) };
        await saveEnrollment(state + '.a2a-runtime.json', runtime);
      }
      console.error(`Hermes Connector: ${prepared.mode} A2A at ${prepared.local}`);
    }
    if (stopped) return 0;
    const outcome = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [join(root, 'vendor/connector/cli.js'), ...forwarded], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
        env: { ...env, A2A_LOCAL_TOKEN: prepared?.token || '', A2A_HERMES_RUNNER_INSTANCE: lock?.owner.instanceId || '' },
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? (stopped ? 0 : 1) : code));
    });
    return outcome ?? 1;
  } catch (error) {
    if (stopped && error.name === 'AbortError') return 0;
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(watcher);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try {
      await prepared?.close();
      if (child && (child.exitCode !== null || child.signalCode !== null) && lock) {
        const owner = await lockOwner(state);
        // A bounded forced stop may skip the child's finally. Reclaim only the
        // exact exited child of this wrapper, never a PID guessed from stale files.
        if (owner?.pid === child.pid && owner.parentInstance === lock.owner.instanceId) {
          await rm(state + '.lock', { recursive: true, force: true });
        }
      }
      if (!short) {
        try {
          const value = JSON.parse(await readFile(state + '.a2a-runtime.json', 'utf8'));
          if (value.pid === process.pid) await rm(state + '.a2a-runtime.json', { force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (lock) {
        try {
          const request = JSON.parse(await readFile(state + '.hermes-stop.json', 'utf8'));
          if (request.instanceId === lock.owner.instanceId) await rm(state + '.hermes-stop.json', { force: true });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally { await lock?.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHermesConnector(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error(`Hermes Connector failed: ${error.message}`); process.exitCode = 1; });
}
