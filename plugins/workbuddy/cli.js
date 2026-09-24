#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = join(homedir(), '.config', 'a2a-connector');
const state = join(dir, 'workbuddy.json');
const settings = join(dir, 'workbuddy-settings.json');
const binary = process.env.A2A_NODE_BINARY || process.execPath;
const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');

async function config() { return JSON.parse(await readFile(settings, 'utf8')); }
function args(c) { return [script, '-relay', c.relay, '-local', c.local, '-state', state, ...(c.allowInsecure ? ['-allow-insecure'] : [])]; }
async function start() {
  const c = await config();
  const child = spawn(binary, args(c), { detached: true, stdio: 'ignore', env: process.env });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  await writeFile(join(dir, 'workbuddy.pid'), String(child.pid), { mode: 0o600 });
}
async function stop() {
  try {
    const pid = Number(await readFile(join(dir, 'workbuddy.pid'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  await unlink(join(dir, 'workbuddy.pid')).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function status() {
  try {
    const enrollment = JSON.parse(await readFile(state, 'utf8'));
    const pid = Number(await readFile(join(dir, 'workbuddy.pid'), 'utf8'));
    process.kill(pid, 0);
    console.log(`Logged in: ${enrollment.agentId}`);
  } catch { console.log('Not logged in'); process.exitCode = 1; }
}
async function login() {
  const input = createInterface({ input: stdin, output: stdout });
  let relay, local, code;
  try {
    relay = await input.question('Relay WSS /connect URL: ');
    local = await input.question('Local A2A HTTP origin: ');
    code = await input.question('One-time pairing code: ');
  } finally { input.close(); }
  if (!code.startsWith('pair_')) throw new Error('Ask the Relay administrator for a pair_ code');
  const c = { relay, local, allowInsecure: false };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await run(binary, [...args(c), '-enroll-only'], { timeout: 20000,
    env: { ...process.env, A2A_PAIR_CODE: code } });
  await writeFile(settings, JSON.stringify(c), { mode: 0o600 });
  await stop();
  await start();
  console.log('Logged in');
}

const command = process.argv.slice(2).join(' ');
try {
  if (command === 'auth login') await login();
  else if (command === 'auth status') await status();
  else if (command === 'auth logout') {
    await stop();
    await Promise.all([state, settings].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    console.log('Logged out');
  } else if (command === 'start') { await start(); console.log('Connector started'); }
  else if (command === 'stop') { await stop(); console.log('Connector stopped'); }
  else throw new Error('Usage: workbuddy-a2a auth login|status|logout or start|stop');
} catch (error) { console.error(error.message); process.exitCode = 1; }
