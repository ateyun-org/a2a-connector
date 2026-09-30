import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

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

export function ownerAlive(owner) {
  if (!owner || owner.hostname !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Atomic directory creation excludes both running and pairing CLI processes.
 * Crash leftovers deliberately fail closed; never reclaim a lock on a PID guess. */
export async function acquireStateLock(path, { parentInstance } = {}) {
  const directory = `${path}.lock`;
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await lockOwner(path);
    throw new Error(`state_locked: ${path}; owner PID ${owner?.pid ?? 'unknown'} on ${owner?.hostname ?? 'unknown'}. Inspect ${directory} before removing a stale lock.`);
  }
  const owner = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), instanceId: randomUUID(),
    ...(parentInstance ? { parentInstance } : {}) };
  try { await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { mode: 0o600 }); }
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
  const running = ownerAlive(owner);
  const fresh = status?.instanceId === owner?.instanceId && Date.now() - Date.parse(status?.updatedAt) < 60000;
  return { ...(fresh ? status : {}), pid: owner?.pid, running,
    tunnelOnline: Boolean(running && fresh && status?.tunnelOnline),
    diagnostic: !running ? 'Connector is stopped (inspect any stale lock)' : !fresh ? 'Tunnel health is unavailable or stale' : undefined };
}
