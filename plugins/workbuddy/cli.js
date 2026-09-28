#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, unlink, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = join(homedir(), '.config', 'a2a-connector');
const instance = process.env.A2A_CONNECTOR_INSTANCE || 'default';
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance)) throw new Error('invalid A2A_CONNECTOR_INSTANCE');
const prefix = instance === 'default' ? 'workbuddy' : `workbuddy-${instance}`;
const state = join(dir, `${prefix}.json`);
const settings = join(dir, `${prefix}-settings.json`);
const pidFile = join(dir, `${prefix}.pid`);
const logFile = join(dir, `${prefix}.stderr.log`);
const binary = process.env.A2A_NODE_BINARY || process.execPath;
const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');

async function config() { return JSON.parse(await readFile(settings, 'utf8')); }
function args(c) { return [script, '-relay', c.relay, '-local', c.local, '-state', state,
  ...(c.agentId ? ['-agent-id', c.agentId] : []), ...(c.allowInsecure ? ['-allow-insecure'] : [])]; }
async function start() {
  const c = await config();
  const log = await open(logFile, 'a', 0o600);
  let child;
  try {
    child = spawn(binary, [...args(c), '-auto-pair'], { detached: true,
      stdio: ['ignore', log.fd, log.fd], env: process.env });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } finally { await log.close(); }
  child.unref();
  await writeFile(pidFile, String(child.pid), { mode: 0o600 });
}
async function stop() {
  try {
    const pid = Number(await readFile(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  await unlink(pidFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function status() {
  try {
    const enrollment = JSON.parse(await readFile(state, 'utf8'));
    const pid = Number(await readFile(pidFile, 'utf8'));
    process.kill(pid, 0);
    console.log(`Logged in: ${enrollment.agentId}`);
  } catch {
    try {
      const pending = JSON.parse(await readFile(state + '.pending', 'utf8'));
      const c = await config();
      const url = new URL(c.relay); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = '/pair';
      console.log(`Awaiting approval: ${url} | Agent: ${pending.agentId} | Confirmation: ${pending.confirmationCode}`);
    } catch { console.log('Not logged in'); process.exitCode = 1; }
  }
}
async function login() {
  const input = createInterface({ input: stdin, output: stdout });
  let relay, local;
  try {
    relay = await input.question('Relay WSS /connect URL: ');
    local = await input.question('Local A2A HTTP origin: ');
  } finally { input.close(); }
  const c = { relay, local, allowInsecure: false };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { stdout: result } = await run(binary, [...args(c), '-request-only'], { timeout: 20000, env: process.env });
  await writeFile(settings, JSON.stringify(c), { mode: 0o600 });
  await stop();
  await start();
  const pairing = JSON.parse(result);
  console.log(pairing.status === 'paired' ? `Already paired: ${pairing.agentId}`
    : `Open ${pairing.approvalURL} and ask the administrator to confirm ${pairing.confirmationCode}. Connection starts automatically after approval.`);
}

const command = process.argv.slice(2).join(' ');
try {
  if (command === 'auth login') await login();
  else if (command === 'auth status') await status();
  else if (command === 'auth logout') {
    await stop();
    await Promise.all([state, state + '.pending', settings].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    console.log('Logged out');
  } else if (command === 'start') { await start(); console.log('Connector started'); }
  else if (command === 'stop') { await stop(); console.log('Connector stopped'); }
  else throw new Error('Usage: workbuddy-a2a auth login|status|logout or start|stop');
} catch (error) { console.error(error.message); process.exitCode = 1; }
