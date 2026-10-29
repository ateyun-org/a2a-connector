#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { acquireStateLock, canonicalState, connectorStatus } from './state-lock.js';
import { Connector, loadEnrollment, register, saveEnrollment, statePath } from './connector.js';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^-+/, '');
    if (['allow-insecure', 'enroll-only', 'status'].includes(key)) result[key] = true;
    else if (['relay', 'local', 'token', 'local-token', 'state', 'agent-id', 'max-request-body'].includes(key)) result[key] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return result;
}

async function existing(path, loader) {
  try { return await loader(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function main() {
  const args = options(process.argv.slice(2));
  const path = await canonicalState(args.state || statePath());
  if (args.status) { console.log(JSON.stringify(await connectorStatus(path))); return; }
  const lock = await acquireStateLock(path, { parentInstance: process.env.A2A_HERMES_RUNNER_INSTANCE });
  try {
    const fingerprint = createHash('sha256').update(path).digest('hex').slice(0, 8);
    const label = basename(path).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
    process.title = `a2a-${fingerprint}-${label}`;
    const code = process.env.A2A_PAIR_CODE;
    const controller = new AbortController();
    const managed = typeof process.send === 'function';
    const stopFromParent = message => {
      if (['connector_shutdown', 'hermes_shutdown'].includes(message?.type)) controller.abort();
    };
    const parentDisconnected = () => controller.abort();
    if (managed) {
      process.on('message', stopFromParent);
      process.once('disconnect', parentDisconnected);
      if (!process.connected) controller.abort();
    }
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
    if (args['enroll-only']) {
      if (!code) throw new Error('enrollment_required: obtain a one-time Agent ticket from the Relay console and provide it privately through A2A_PAIR_CODE');
      const enrollment = await register({ relay: args.relay, code, allowInsecure: !!args['allow-insecure'] });
      await saveEnrollment(path, enrollment);
      if (args['agent-id'] && enrollment.agentId !== args['agent-id']) throw new Error('enrolled identity does not match the expected Agent ID; saved state retained for inspection');
      console.log(`Agent enrolled: ${enrollment.agentId} ${enrollment.card || ''}`);
      return;
    }
    const enrollment = await existing(path, loadEnrollment);
    const token = args.token || process.env.A2A_CONNECTOR_TOKEN || enrollment?.token;
    if (!token) throw new Error('enrollment_required: use a console-issued Agent ticket with -enroll-only before starting this Connector');
    if (args['agent-id'] && token.startsWith('agt_') && token.slice(4).split('.')[0] !== args['agent-id']) throw new Error('stored identity does not match the configured Agent ID');
    const connector = new Connector({ relay: args.relay, local: args.local, token,
      maxRequestBodyBytes: args['max-request-body'] === undefined ? undefined : Number(args['max-request-body']),
      localToken: args['local-token'] || process.env.A2A_LOCAL_TOKEN,
      allowInsecure: !!args['allow-insecure'] });
    const health = { ...lock.owner, agentId: token.startsWith('agt_') ? token.slice(4).split('.')[0] : undefined,
      tunnelOnline: false, reconnects: 0 };
    let writes = Promise.resolve();
    const saveHealth = () => {
      const snapshot = { ...health, updatedAt: new Date().toISOString() };
      writes = writes.then(() => saveEnrollment(path + '.status.json', snapshot));
      writes = writes.catch(() => {});
    };
    connector.config.onStatus = event => { Object.assign(health, event); saveHealth(); };
    saveHealth();
    const heartbeat = setInterval(saveHealth, 15000);
    try { await connector.run(controller.signal); }
    finally { clearInterval(heartbeat); health.tunnelOnline = false; saveHealth(); await writes; }
  } finally {
    await lock.release();
    // A managed child must release its lock before dropping IPC or exiting.
    if (process.connected && typeof process.disconnect === 'function') process.disconnect();
  }
}

main().catch(error => {
  if (error.name !== 'AbortError') {
    console.error(`A2A Connector: ${error.message}`);
    // Supervisors may retry contention, but must not repeat an uncertain one-time
    // pairing redemption or loop on invalid settings/credentials.
    process.exitCode = error.message.startsWith('state_locked:') ? 75 : 78;
  }
  if (process.connected && typeof process.disconnect === 'function') process.disconnect();
});
