import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
// Include process birth identity, since a PID can be reused after a reboot.
async function processIdentity(pid) {
  if (process.platform === 'linux') {
    const [boot, stat] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
    return `${boot.trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5000 });
    return /^\d+$/.test(stdout.trim()) ? stdout.trim() : undefined;
  }
  const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'lstart='],
    { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.trim() || undefined;
}
let selfIdentity;
const ownIdentity = () => selfIdentity ??= processIdentity(process.pid).catch(() => undefined);

export async function canonicalState(path) {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(path)), basename(path));
  }
}

export async function lockOwner(path) {
  try { return JSON.parse(await readFile(`${path}.lock/owner.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function ownerAlive(owner) {
  if (!owner || owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  if (typeof owner.processIdentity === 'string' && owner.processIdentity.length > 0) {
    try {
      const identity = await processIdentity(owner.pid);
      if (identity) return identity === owner.processIdentity;
    } catch { /* An unavailable process query is not proof of a dead owner. */ }
  }
  return true;
}

function recoverable(owner) {
  return owner?.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.instanceId === 'string' && owner.instanceId.length > 0 &&
    (owner.processIdentity === undefined || (typeof owner.processIdentity === 'string' && owner.processIdentity.length > 0));
}
const sameOwner = (a, b) => a?.instanceId === b?.instanceId && a?.pid === b?.pid && a?.hostname === b?.hostname;

/** Serialize reclamation inside the old directory, then quarantine it atomically.
 * Never recursively remove the canonical path: another starter may already own it. */
export async function acquireStateLock(path, { parentInstance, recoveryDepth = 0 } = {}) {
  const directory = `${path}.lock`;
  // Resolve identity before mkdir, so the owner-publication window stays short.
  const identity = await ownIdentity();
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(directory, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await lockOwner(path);
      if (attempt < 20 && recoveryDepth < 5 && recoverable(owner) && !await ownerAlive(owner)) {
        let guard;
        try {
          guard = await acquireStateLock(join(directory, 'recovery'), { recoveryDepth: recoveryDepth + 1 });
          const current = await lockOwner(path);
          if (sameOwner(current, owner) && !await ownerAlive(current)) {
            const quarantine = `${directory}.stale-${randomUUID()}`;
            await rename(directory, quarantine);
            // The guard moved with the old lock; never release via its former path.
            guard = undefined;
            await rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          }
        } catch (recoveryError) {
          if (recoveryError.code !== 'ENOENT' && !recoveryError.message.startsWith('state_locked:')) throw recoveryError;
        } finally { await guard?.release(); }
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }
      // A contender can arrive between mkdir and publication of owner.json.
      if (!owner && attempt < 20) { await new Promise(resolve => setTimeout(resolve, 10)); continue; }
      throw new Error(`state_locked: ${path}; owner PID ${owner?.pid ?? 'unknown'} on ${owner?.hostname ?? 'unknown'}. Inspect ${directory}; ownership could not be safely reclaimed.`);
    }
  }
  const owner = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), instanceId: randomUUID(),
    ...(identity ? { processIdentity: identity } : {}),
    ...(parentInstance ? { parentInstance } : {}) };
  try {
    const temporary = join(directory, `.owner-${owner.instanceId}`);
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'owner.json'));
  }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { owner, async release() {
    if ((await lockOwner(path))?.instanceId === owner.instanceId) await rm(directory, { recursive: true, force: true });
  } };
}

export async function connectorStatus(path) {
  const owner = await lockOwner(path);
  let status;
  try { status = JSON.parse(await readFile(`${path}.status.json`, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const running = await ownerAlive(owner);
  const age = Date.now() - Date.parse(status?.updatedAt);
  const fresh = running && status?.instanceId === owner?.instanceId && age >= 0 && age < 60000;
  return { ...(fresh ? status : {}), pid: owner?.pid, running,
    tunnelOnline: Boolean(running && fresh && status?.tunnelOnline),
    staleLock: Boolean(owner && !running),
    diagnostic: !running ? 'Connector is stopped; verified dead local locks are recovered on start' : !fresh ? 'Tunnel health is unavailable or stale' : undefined };
}
