#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, unlink, open } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { callAgent, getAgentTask, listTargets, recoverDispatch, controlAgentTask } from './a2a-client.js';
import { platformAccessToken, platformAuthorizationURL, platformRequest } from './platform-client.js';
import { acquireStateLock, connectorStatus, lockOwner, ownerAlive } from './vendor/connector/state-lock.js';
import { loadEnrollment, validateConfig } from './vendor/connector/connector.js';
import { CloudAPI, cloudTaskId } from "./cloud-api.js";
import { DesktopAPI } from './desktop-api.js';
import { TaskStore } from './task-store.js';
import { taskView } from './adapter-server.js';

const run = promisify(execFile);
const dir = process.env.A2A_CONNECTOR_CONFIG_DIR || join(homedir(), '.config', 'a2a-connector');
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
const runner = join(dirname(fileURLToPath(import.meta.url)), 'runner.js');

async function config() { return JSON.parse(await readFile(settings, 'utf8')); }
function args(c) { return [script, '-relay', c.relay, '-local', c.local, '-state', state,
  ...(c.agentId ? ['-agent-id', c.agentId] : []), ...(c.allowInsecure ? ['-allow-insecure'] : [])]; }
async function existingPid() {
  let raw;
  try { raw = await readFile(pidFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`invalid PID file: ${pidFile}`);
  const c = await config();
  const owner = await lockOwner(["desktop", "cloud"].includes(c.adapter) ? state + '.runner' : state);
  if (owner) {
    if (owner.hostname !== hostname() || owner.pid !== pid) throw new Error('WorkBuddy PID marker does not match its managed lock; inspect local state');
    if (await ownerAlive(owner)) return pid;
    await unlink(pidFile);
    return null;
  }
  try { process.kill(pid, 0); throw new Error('WorkBuddy PID is live without a managed owner; inspect it before recovery'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
    await unlink(pidFile);
    return null;
  }
}
async function start() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireStateLock(startLock.slice(0, -5));
  try {
    const prior = await existingPid();
    if (prior) throw new Error(`Connector already running (PID ${prior}); stop it before starting another`);
    const c = await config();
    const log = await open(logFile, 'a', 0o600);
    let child;
    try {
      const builtin = ["desktop", "cloud"].includes(c.adapter);
      child = spawn(binary, builtin ? [runner, settings, state] : [...args(c), '-auto-pair'], { detached: true,
        stdio: builtin ? ['ignore', log.fd, log.fd, 'ipc'] : ['ignore', log.fd, log.fd], env: process.env });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WorkBuddy runner startup timed out; inspect private diagnostics')), 7000);
        const ready = () => { clearTimeout(timer); resolve(); };
        const failed = () => { clearTimeout(timer); reject(new Error('WorkBuddy runner could not start; inspect private diagnostics')); };
        child.once('error', failed);
        child.once('exit', failed);
        if (builtin) child.on('message', message => {
          if (message?.type === 'workbuddy_ready') ready();
          if (message?.type === 'workbuddy_start_failed') failed();
        });
        else child.once('spawn', ready);
      }).catch(error => { child.kill('SIGTERM'); throw error; });
      if (child.connected) child.disconnect();
    } finally { await log.close(); }
    child.unref();
    try { await writeFile(pidFile, String(child.pid), { mode: 0o600, flag: 'wx' }); }
    catch (error) { child.kill('SIGTERM'); throw error; }
  } finally { await lock.release(); }
}
async function stop() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireStateLock(startLock.slice(0, -5));
  try {
    const pid = await existingPid();
    if (pid) {
      const c = await config();
      const owner = await lockOwner(["desktop", "cloud"].includes(c.adapter) ? state + '.runner' : state);
      process.kill(pid, 'SIGTERM');
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!await ownerAlive(owner)) break;
        if (attempt === 99) throw new Error('Connector is still stopping; inspect it before starting another');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await unlink(pidFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  finally { await lock.release(); }
}
async function status() {
  try {
    const enrollment = await loadEnrollment(state);
    const health = await connectorStatus(state);
    if (!health.tunnelOnline) throw new Error('Connector tunnel is offline');
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
    local = await input.question('Local A2A HTTP origin (leave empty for the built-in WorkBuddy desktop adapter): ');
  } finally { input.close(); }
  const c = local.trim() ? { relay, local, allowInsecure: false } : { relay, adapter: 'desktop', name: 'WorkBuddy Desktop', allowInsecure: false };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (c.adapter === 'desktop') {
    await saveSettings(c);
    if (!(await existingPid())) await start();
    console.log('Connector started with the WorkBuddy desktop adapter. Run auth status to view pairing approval, then platform login.');
    return;
  }
  await saveSettings(c);
  const { stdout: result } = await run(binary, [...args(c), '-request-only'], { timeout: 20000, env: process.env });
  await stop();
  await start();
  const pairing = JSON.parse(result);
  console.log(pairing.status === 'paired' ? `Already paired: ${pairing.agentId}`
    : `Open ${pairing.approvalURL} and ask the administrator to confirm ${pairing.confirmationCode}. Connection starts automatically after approval.`);
}

async function saveSettings(c) {
  validateConfig({ ...c, local: c.local || 'http://127.0.0.1', token: 'pending' });
  try {
    const prior = await config();
    const ordered = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
    if (ordered(prior) !== ordered(c)) throw new Error('Existing WorkBuddy settings differ; stop and inspect them or use a separate A2A_CONNECTOR_INSTANCE');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(settings, JSON.stringify(c), { mode: 0o600 });
}

// GUI connector authentication has no TTY and must return its URL promptly.
async function connect() {
  let c;
  try { c = await config(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!process.env.A2A_RELAY_URL) throw new Error('Run setup --relay <wss-url> first or configure A2A_RELAY_URL');
    await saveSettings({ adapter: 'desktop', name: 'WorkBuddy Desktop', allowInsecure: false, relay: process.env.A2A_RELAY_URL });
    c = await config();
  }
  if (!(await existingPid())) await start();
  const url = new URL(c.relay);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/pair';
  console.log(`Approve this WorkBuddy Agent at ${url.toString()} then use auth status to compare its confirmation code.`);
}

async function setup(argv) {
  const c = { adapter: 'desktop', name: 'WorkBuddy Desktop', allowInsecure: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') c.relay = argv[++i];
    else if (argv[i] === '--mode') c.adapter = argv[++i];
    else if (argv[i] === '--task-id') c.cloudTaskId = cloudTaskId(argv[++i]);
    else if (argv[i] === '--cwd') c.cwd = argv[++i];
    else if (argv[i] === '--name') c.name = argv[++i];
    else if (argv[i] === '--agent-id') c.agentId = argv[++i];
    else if (argv[i] === '--allow-insecure') c.allowInsecure = true;
    else throw new Error(`Unknown setup option: ${argv[i]}`);
  }
  if (!['desktop', 'cloud'].includes(c.adapter)) throw new Error('Mode must be desktop or cloud');
  if (c.adapter !== 'cloud' && (c.cloudTaskId || c.cwd)) throw new Error('--task-id and --cwd require --mode cloud');
  if (c.cwd !== undefined && (typeof c.cwd !== 'string' || !c.cwd.startsWith('/') || c.cwd.length > 1024 || /[\u0000-\u001f]/.test(c.cwd))) throw new Error('Invalid cloud working directory');
  if (c.adapter === 'cloud' && c.name === 'WorkBuddy Desktop') c.name = 'WorkBuddy Cloud';
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 120) throw new Error('Agent name must contain 1 to 120 characters');
  if (c.agentId && !/^[A-Za-z0-9_-]{1,64}$/.test(c.agentId)) throw new Error('Invalid Agent ID');
  await saveSettings(c);
  if (!(await existingPid())) await start();
  console.log(`WorkBuddy ${c.adapter} adapter started. Run auth status for pairing approval, then platform login for WorkBuddy authorization.`);
}

async function doctor() {
  const c = await config();
  const result = { adapter: c.adapter || 'external', paired: false, tunnelOnline: false, linked: false,
    ...(c.adapter === 'cloud' ? { cloudAvailable: false } : { desktopOnline: false }) };
  try {
    const options = await platformOptions();
    const health = await connectorStatus(state);
    result.paired = true;
    result.agentId = options.enrollment.agentId;
    result.tunnelOnline = health.tunnelOnline === true;
    const authorization = await platformRequest({ ...options, endpoint: 'status' });
    result.linked = authorization.linked === true;
    result.scope = authorization.scope;
    if (result.linked) {
      if (c.adapter === 'cloud') {
        const api = new CloudAPI({ accessToken: () => platformAccessToken(options) });
        await api.list({ size: 1 });
        if (c.cloudTaskId) {
          const task = await api.get(c.cloudTaskId);
          result.cloudTaskId = task.task_id; result.cloudStatus = task.status;
          if (['failed', 'archived', 'deleted'].includes(task.status)) throw new Error('Bound cloud session is unavailable');
        }
        result.cloudAvailable = true;
      } else result.desktopOnline = (await new DesktopAPI({ accessToken: () => platformAccessToken(options) }).status()).online;
    }
  } catch (error) { result.issue = error.message; }
  console.log(JSON.stringify(result));
  if (!result.paired || !result.tunnelOnline || !result.linked || !(result.cloudAvailable || result.desktopOnline)) process.exitCode = 1;
}

async function cloudTasks(id) {
  const api = new CloudAPI({ accessToken: async () => platformAccessToken(await platformOptions()) });
  const safe = task => ({ taskId: task.task_id, status: task.status, name: task.name,
    createdAt: task.created_at, updatedAt: task.updated_at });
  if (id) console.log(JSON.stringify(safe(await api.get(cloudTaskId(id)))));
  else {
    const result = await api.list();
    console.log(JSON.stringify({ tasks: result.tasks.map(safe), total: result.total, page: 1, size: 100 }));
  }
}

async function localTask(id) {
  const task = (await new TaskStore(state + '.tasks.json').list()).find(value => value.id === id);
  if (!task) throw new Error('Task not found');
  console.log(JSON.stringify(taskView(task)));
}

async function call(targetId, messageId = randomUUID(), contextId) {
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 256) throw new Error('invalid message ID');
  const c = await config();
  const enrollment = await loadEnrollment(state);
  let prompt = '';
  for await (const chunk of stdin) {
    prompt += chunk;
    if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error('task text is too large');
  }
  if (!prompt.trim()) throw new Error('task text is required on stdin');
  const store = new TaskStore(state + '.outbound.json');
  const fingerprint = createHash('sha256').update(JSON.stringify(contextId ? [targetId, prompt, contextId] : [targetId, prompt])).digest('hex');
  let created = false;
  const record = await store.transact(tasks => {
    const prior = tasks.find(value => value.messageId === messageId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('message ID already used for different task content');
      if (prior.dispatchState === 'not-sent') {
        created = true;
        prior.dispatchState = 'reserved';
        prior.state = 'TASK_STATE_SUBMITTED';
        prior.updatedAt = new Date().toISOString();
      }
      return prior;
    }
    created = true;
    const value = { id: randomBytes(16).toString('hex'), messageId, fingerprint, targetId,
      state: 'TASK_STATE_SUBMITTED', dispatchState: 'reserved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    tasks.push(value);
    return value;
  });
  if (!created) { await outboundStatus(record.id); return; }
  const update = change => store.transact(tasks => Object.assign(tasks.find(value => value.id === record.id), change,
    { updatedAt: new Date().toISOString() }));
  let result;
  let sending = false;
  try {
    result = await callAgent({ relay: c.relay, allowInsecure: c.allowInsecure,
      enrollment, targetId, prompt, messageId, contextId, relayRequestId: record.id,
      onDispatch: async () => { await update({ dispatchState: 'dispatching' }); sending = true; },
      onTask: task => update({ remoteTaskId: task.taskId, state: task.state, dispatchState: 'sent' }) });
    await update({ state: result.state === 'MESSAGE' ? 'TASK_STATE_COMPLETED' : result.state, dispatchState: 'sent', result });
  } catch (error) {
    await update({ state: sending ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_FAILED',
      dispatchState: sending ? 'unknown' : 'not-sent', issue: error.message });
    throw new Error(`${error.message}; request ${record.id} saved. Query workbuddy-a2a outbound ${record.id} before retrying`);
  }
  console.log(JSON.stringify({ ...result, messageId, relayRequestId: record.id }));
  if (result.state === 'TASK_STATE_FAILED' || result.state === 'TASK_STATE_CANCELED' ||
      result.state === 'TASK_STATE_REJECTED') process.exitCode = 1;
}

async function outboundStatus(id) {
  const store = new TaskStore(state + '.outbound.json');
  const record = (await store.list()).find(value => value.id === id);
  if (!record) throw new Error('Outbound request not found');
  if (record.dispatchState === 'not-sent') {
    console.log(JSON.stringify({ targetId: record.targetId, state: 'TASK_STATE_FAILED',
      text: record.issue || 'Preflight failed before sending the task', messageId: record.messageId, relayRequestId: id, dispatched: false }));
    process.exitCode = 1;
    return;
  }
  const options = { ...(await platformOptions()), targetId: record.targetId };
  const result = record.result && record.state === 'TASK_STATE_COMPLETED' ? record.result : record.remoteTaskId
    ? await getAgentTask(options, record.remoteTaskId) : await recoverDispatch(options, id);
  await store.transact(tasks => Object.assign(tasks.find(value => value.id === id), {
    result, ...(result.taskId ? { remoteTaskId: result.taskId } : {}),
    state: result.state === 'MESSAGE' ? 'TASK_STATE_COMPLETED' : result.state,
    updatedAt: new Date().toISOString(),
  }));
  console.log(JSON.stringify({ ...result, messageId: record.messageId, relayRequestId: id }));
  if (['TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(result.state)) process.exitCode = 1;
}

async function task(targetId, taskId) {
  const c = await config();
  const enrollment = await loadEnrollment(state);
  const result = await getAgentTask({ relay: c.relay, allowInsecure: c.allowInsecure,
    enrollment, targetId }, taskId);
  console.log(JSON.stringify(result));
  if (result.state === 'TASK_STATE_FAILED' || result.state === 'TASK_STATE_CANCELED' ||
      result.state === 'TASK_STATE_REJECTED') process.exitCode = 1;
}

async function platformOptions() {
  const enrollment = await loadEnrollment(state);
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
  if (argv[0] === 'setup') await setup(argv.slice(1));
  else if (command === 'doctor') await doctor();
  else if (command === 'targets') console.log(JSON.stringify(await listTargets(await platformOptions())));
  else if (argv.length === 3 && argv[0] === 'adapter' && argv[1] === 'task') await localTask(argv[2]);
  else if (command === 'auth login') await login();
  else if (command === 'auth connect') await connect();
  else if (command === 'auth status') await status();
  else if (command === 'auth logout') {
    await stop();
    await Promise.all([state, state + '.pending', settings].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    console.log('Logged out');
  } else if (command === 'start') { await start(); console.log('Connector started'); }
  else if (command === 'stop') { await stop(); console.log('Connector stopped'); }
  else if (argv[0] === 'call' && argv.length >= 2) {
    let messageId, contextId;
    for (let i = 2; i < argv.length; i += 2) {
      if (!argv[i + 1]) throw new Error('Missing call option value');
      if (argv[i] === '--message-id') messageId = argv[i + 1];
      else if (argv[i] === '--context-id') contextId = argv[i + 1];
      else throw new Error('Unknown call option');
    }
    if (contextId !== undefined && (!contextId || contextId.length > 256)) throw new Error('Invalid context ID');
    await call(argv[1], messageId, contextId);
  }
  else if (command === 'cloud tasks') await cloudTasks();
  else if (argv.length === 3 && argv[0] === 'cloud' && argv[1] === 'task') await cloudTasks(argv[2]);
  else if (argv.length === 3 && argv[0] === 'cancel') console.log(JSON.stringify(await controlAgentTask({ ...(await platformOptions()), targetId: argv[1] }, 'CancelTask', { id: argv[2] })));
  else if ([3, 4].includes(argv.length) && argv[0] === 'release') console.log(JSON.stringify(await controlAgentTask({ ...(await platformOptions()), targetId: argv[1] }, 'ReleaseCloudTask', { id: argv[2], cloudTaskId: argv[3] })));
  else if (argv.length === 5 && argv[0] === 'permission') {
    // Request IDs are transported as JSON so both numeric and string ACP IDs remain exact.
    let requestId;
    try { requestId = JSON.parse(argv[3]); } catch { throw new Error('Permission request ID must be a JSON string or number'); }
    if (typeof requestId !== 'string' && !(typeof requestId === 'number' && Number.isFinite(requestId))) throw new Error('Invalid permission request ID');
    console.log(JSON.stringify(await controlAgentTask({ ...(await platformOptions()), targetId: argv[1] }, 'RespondPermission', { id: argv[2], requestId, optionId: argv[4] })));
  }
  else if (argv.length === 2 && argv[0] === 'outbound') await outboundStatus(argv[1]);
  else if (argv.length === 3 && argv[0] === 'task') await task(argv[1], argv[2]);
  else if (command === 'platform login') await platformLogin();
  else if (command === 'platform status') await platformStatus();
  else if (command === 'platform logout') await platformLogout();
  else throw new Error('Usage: workbuddy-a2a setup --relay <wss-url> [--mode desktop|cloud] [--task-id <cloud-session-id>] [--cwd /workspace] [--name <name>], doctor, targets, auth connect|login|status|logout, platform login|status|logout, start|stop, call <target-agent-id> [--message-id <id>] [--context-id <id>] (stdin), outbound <request-id>, task <target-agent-id> <task-id>, adapter task <task-id>, cloud tasks, cloud task <cloud-session-id>, cancel <target-agent-id> <task-id>, release <target-agent-id> <task-id> [recovered-cloud-task-id], permission <target-agent-id> <task-id> <request-id-as-json> <option-id>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
