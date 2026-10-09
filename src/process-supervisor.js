import { randomUUID } from 'node:crypto';

/** Keep one managed child alive, with bounded retries and explicit stop semantics. */
export function createProcessSupervisor({ launch, onError = () => {}, minDelayMs = 1000,
  maxDelayMs = 30000, stableMs = 60000, stopTimeoutMs = 5000 } = {}) {
  let child, wanted = false, timer, stopping, failures = 0, recentLogs = '', run;
  const remember = chunk => {
    recentLogs = (recentLogs + chunk.toString()).slice(-65536);
    if (run) run.lastLogAt = new Date().toISOString();
  };
  function schedule() {
    if (!wanted || timer) return;
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(failures++, 10));
    run.retryAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(() => { timer = undefined; start(); }, delay);
    timer.unref?.();
  }
  function start() {
    wanted = true;
    if (child || timer || stopping) return;
    recentLogs = '';
    run = { id: randomUUID(), startedAt: new Date().toISOString() };
    let active;
    try { active = launch(); }
    catch (error) { remember(error.message + '\n'); onError(error); schedule(); return; }
    child = active;
    run.pid = active.pid;
    active.stdout?.on('data', remember);
    active.stderr?.on('data', remember);
    active.once('error', error => { remember(error.message + '\n'); onError(error); });
    // close runs after stdio drains, so old output cannot leak into the next run.
    active.once('close', (code, signal) => {
      if (child !== active) return;
      child = undefined;
      run.endedAt = new Date().toISOString();
      run.exitCode = code; run.signal = signal;
      if (code === 78 && wanted) {
        run.restartBlocked = 'Configuration or pairing error; inspect logs before restarting';
        wanted = false;
      }
      if (Date.now() - Date.parse(run.startedAt) >= stableMs) failures = 0;
      schedule();
    });
  }
  async function stop() {
    wanted = false;
    clearTimeout(timer); timer = undefined;
    if (run) delete run.retryAt;
    if (stopping) return stopping;
    const active = child;
    if (!active) return;
    stopping = (async () => {
      const closed = new Promise(resolve => active.once('close', resolve));
      const deadline = setTimeout(() => active.kill('SIGKILL'), stopTimeoutMs);
      try {
        // Windows SIGTERM is a forced termination. IPC lets the CLI release locks.
        if (active.exitCode === null && active.signalCode === null) {
          if (active.connected) active.send({ type: 'connector_shutdown' }, () => {});
          else active.kill('SIGTERM');
        }
        await closed;
      } finally { clearTimeout(deadline); }
    })();
    try { await stopping; }
    finally { stopping = undefined; if (child === active) child = undefined; }
  }
  return { start, stop, remember, status: () => ({
    recentLogs: recentLogs.slice(-8192), logRun: run ? { ...run } : undefined,
    logsAreHistorical: true, restartScheduled: Boolean(timer),
  }) };
}
