#!/usr/bin/env node
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startReceiver } from './receiver-runtime.js';
import { loadEnrollment, validateConfig } from './vendor/connector/connector.js';
import { connectorStatus } from './vendor/connector/state-lock.js';
import { platformSetupURL, platformRequest } from './platform-client.js';

export function hostedConfig(input = {}, base = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid hosted configuration');
  const relay = input.relay || 'wss://dsh-relay.chuanbota.com/connect';
  validateConfig({ relay, local: 'http://127.0.0.1', token: 'pending', allowInsecure: input.allowInsecure === true });
  const stateDir = resolve(base, input.stateDir || process.env.A2A_HOSTED_STATE_DIR || './workbuddy-state');
  const entries = input.receivers || [{ agentId: 'chuanbota-workbuddy-cloud', name: '传播塔 WorkBuddy', adapter: 'hybrid' }];
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error('Configure between 1 and 1000 receivers');
  const ids = new Set(), paths = new Set();
  const receivers = entries.map(entry => {
    if (!entry || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.agentId || '') || ids.has(entry.agentId)) throw new Error('Receiver Agent IDs must be valid and unique');
    const adapter = entry.adapter || 'hybrid';
    if (!['desktop', 'cloud', 'hybrid'].includes(adapter) || !['cloud', 'desktop'].includes(entry.defaultMode || 'cloud')) throw new Error('Invalid hosted execution mode');
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120) throw new Error('Receiver name is required');
    const state = entry.stateFile ? resolve(base, entry.stateFile) : join(stateDir, entry.agentId + '.json');
    if (paths.has(state)) throw new Error('Receivers must have separate state files');
    ids.add(entry.agentId); paths.add(state);
    return { relay, allowInsecure: input.allowInsecure === true, adapter, agentId: entry.agentId, name: entry.name,
      defaultMode: entry.defaultMode || 'cloud', cloudTaskId: entry.cloudTaskId, cwd: entry.cwd, state };
  });
  return { stateDir, receivers };
}

export async function startHosted(config, { runtimeFactory = startReceiver } = {}) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const runtimes = [];
  const close = async () => {
    const results = await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('Hosted receiver shutdown failed');
  };
  try {
    for (const receiver of config.receivers) runtimes.push(await runtimeFactory(receiver, receiver.state));
    return { runtimes, close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const [command = 'serve', configPath, agentId] = process.argv.slice(2);
  const candidate = configPath || process.env.A2A_HOSTED_CONFIG || join(process.env.A2A_HOSTED_STATE_DIR || './workbuddy-state', 'hosted.json');
  let input = {}, base = process.cwd();
  try { input = JSON.parse(await readFile(candidate, 'utf8')); base = resolve(candidate, '..'); }
  catch (error) { if (error.code !== 'ENOENT' || configPath || process.env.A2A_HOSTED_CONFIG) throw error; }
  const config = hostedConfig(input, base);
  if (command === 'status') {
    const receivers = await Promise.all(config.receivers.map(async receiver => {
      const health = await connectorStatus(receiver.state);
      let linked = false;
      try { linked = (await platformRequest({ ...receiver, enrollment: await loadEnrollment(receiver.state), endpoint: 'status' })).linked === true; }
      catch { /* Return readiness, never upstream credentials. */ }
      return { agentId: receiver.agentId, adapter: receiver.adapter, running: health.running === true,
        tunnelOnline: health.tunnelOnline === true, linked };
    }));
    console.log(JSON.stringify({ receivers }));
    if (receivers.some(receiver => !receiver.tunnelOnline || !receiver.linked)) process.exitCode = 1;
    return;
  }
  if (command === 'authorize') {
    const receiver = config.receivers.find(value => value.agentId === (agentId || config.receivers[0].agentId));
    if (!receiver) throw new Error('Unknown hosted receiver');
    const enrollment = await loadEnrollment(receiver.state);
    if (enrollment.agentId !== receiver.agentId) throw new Error('Stored identity does not match hosted receiver');
    console.log(await platformSetupURL({ ...receiver, enrollment }, receiver.adapter === 'hybrid' ? receiver.defaultMode : receiver.adapter));
    return;
  }
  if (command !== 'serve') throw new Error('Usage: node hosted.js serve|status|authorize [config.json] [agent-id]');
  const stopped = new Promise(resolveStop => {
    process.once('SIGTERM', resolveStop); process.once('SIGINT', resolveStop);
  });
  const host = await startHosted(config);
  try {
    console.log(`WorkBuddy hosted service started with ${config.receivers.length} receiver(s); no user-machine A2A service required.`);
    await stopped;
  } finally { await host.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('WorkBuddy hosted service failed; inspect configuration, private state and pairing diagnostics.'); process.exitCode = 78;
});
