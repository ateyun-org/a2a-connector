#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, rmdir, unlink, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { callAgent, getAgentTask } from './a2a-client.js';
import { platformAuthorizationURL, platformRequest } from './platform-client.js';

const run = promisify(execFile);
const dir = join(homedir(), '.config', 'a2a-connector');
const instance = process.env.A2A_CONNECTOR_INSTANCE || 'default';
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance)) throw new Error('invalid A2A_CONNECTOR_INSTANCE');
const prefix = instance === 'default' ? 'workbuddy' : `workbuddy-${instance}`;
const state = join(dir, `${prefix}.json`);
const settings = join(dir, `${prefix}-settings.json`);
const pidFile = join(dir, `${prefix}.pid`);
const startLock = join(dir, `${prefix}.start.lock`);
const logFile = join(dir, `${prefix}.stderr.log`);
const binary = process.env.A2A_NODE_BINARY || process.execPath;
const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');

async function config() { return JSON.parse(await readFile(settings, 'utf8')); }
function args(c) { return [script, '-relay', c.relay, '-local', c.local, '-state', state,
  ...(c.agentId ? ['-agent-id', c.agentId] : []), ...(c.allowInsecure ? ['-allow-insecure'] : [])]; }
async function existingPid() {
  let raw;
  try { raw = await readFile(pidFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid PID file: ${pidFile}`);
  try { process.kill(pid, 0); return pid; }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
    await unlink(pidFile);
    return null;
  }
}
async function start() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(startLock, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`another start is in progress: ${startLock}`);
    throw error;
  });
  try {
    const prior = await existingPid();
    if (prior) throw new Error(`Connector already running (PID ${prior}); stop it before starting another`);
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
    try { await writeFile(pidFile, String(child.pid), { mode: 0o600, flag: 'wx' }); }
    catch (error) { child.kill('SIGTERM'); throw error; }
  } finally { await rmdir(startLock); }
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

async function call(targetId) {
  const c = await config();
  const enrollment = JSON.parse(await readFile(state, 'utf8'));
  let prompt = '';
  for await (const chunk of stdin) {
    prompt += chunk;
    if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error('task text is too large');
  }
  const result = await callAgent({ relay: c.relay, allowInsecure: c.allowInsecure,
    enrollment, targetId, prompt });
  console.log(JSON.stringify(result));
  if (result.state === 'TASK_STATE_FAILED' || result.state === 'TASK_STATE_CANCELED' ||
      result.state === 'TASK_STATE_REJECTED') process.exitCode = 1;
}

async function task(targetId, taskId) {
  const c = await config();
  const enrollment = JSON.parse(await readFile(state, 'utf8'));
  const result = await getAgentTask({ relay: c.relay, allowInsecure: c.allowInsecure,
    enrollment, targetId }, taskId);
  console.log(JSON.stringify(result));
  if (result.state === 'TASK_STATE_FAILED' || result.state === 'TASK_STATE_CANCELED' ||
      result.state === 'TASK_STATE_REJECTED') process.exitCode = 1;
}

async function platformOptions() {
  const enrollment = JSON.parse(await readFile(state, 'utf8'));
  let c;
  try { c = await config(); }
  catch (error) {
    if (error.code !== 'ENOENT' || !enrollment.card) throw error;
    const relay = new URL(enrollment.card);
    if (relay.protocol !== 'https:' && relay.protocol !== 'http:') throw new Error('invalid paired Relay card URL');
    const allowInsecure = relay.protocol === 'http:';
    relay.protocol = allowInsecure ? 'ws:' : 'wss:';
    relay.pathname = '/connect'; relay.search = ''; relay.hash = '';
    c = { relay: relay.toString(), allowInsecure };
  }
  return { relay: c.relay, allowInsecure: c.allowInsecure, enrollment };
}

async function platformLogin() {
  const authorizationURL = await platformAuthorizationURL(await platformOptions());
  console.log(`Open this WorkBuddy authorization URL:\n${authorizationURL}`);
  console.log('After approving, run: workbuddy-a2a platform status');
}

async function platformStatus() {
  const result = await platformRequest({ ...(await platformOptions()), endpoint: 'status' });
  console.log(result.linked ? `WorkBuddy linked (scope: ${result.scope || 'unknown'})` : 'WorkBuddy not linked');
  if (!result.linked) process.exitCode = 1;
}

async function platformLogout() {
  await platformRequest({ ...(await platformOptions()), endpoint: 'session', method: 'DELETE' });
  console.log('WorkBuddy link removed from Relay');
}

const argv = process.argv.slice(2);
const command = argv.join(' ');
try {
  if (command === 'auth login') await login();
  else if (command === 'auth status') await status();
  else if (command === 'auth logout') {
    await stop();
    await Promise.all([state, state + '.pending', settings].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    console.log('Logged out');
  } else if (command === 'start') { await start(); console.log('Connector started'); }
  else if (command === 'stop') { await stop(); console.log('Connector stopped'); }
  else if (argv.length === 2 && argv[0] === 'call') await call(argv[1]);
  else if (argv.length === 3 && argv[0] === 'task') await task(argv[1], argv[2]);
  else if (command === 'platform login') await platformLogin();
  else if (command === 'platform status') await platformStatus();
  else if (command === 'platform logout') await platformLogout();
  else throw new Error('Usage: workbuddy-a2a auth login|status|logout, platform login|status|logout, start|stop, call <target-agent-id> (task text on stdin), or task <target-agent-id> <task-id>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
