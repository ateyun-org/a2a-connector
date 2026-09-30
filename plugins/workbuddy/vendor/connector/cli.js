#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { acquireStateLock, canonicalState, connectorStatus } from './state-lock.js';
import { Connector, loadEnrollment, loadPendingPairing, pairingStatus, register, requestPairing,
  saveEnrollment, statePath, waitForPairing } from './connector.js';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^-+/, '');
    if (['allow-insecure', 'enroll-only', 'auto-pair', 'request-only', 'status'].includes(key)) result[key] = true;
    else if (['relay', 'local', 'token', 'local-token', 'state', 'pair-code', 'agent-id', 'max-request-body'].includes(key)) result[key] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return result;
}

async function existing(path, loader) {
  try { return await loader(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function ensurePairing(args, path, signal, previousAgentId) {
  const pendingPath = path + '.pending';
  let pending = await existing(pendingPath, loadPendingPairing);
  if (pending) {
    const status = await pairingStatus({ relay: args.relay, requestId: pending.requestId,
      allowInsecure: !!args['allow-insecure'], signal });
    if (status.status !== 'expired') return pending;
  }
  if (pending) await rm(pendingPath, { force: true });
  const connector = new Connector({ relay: args.relay, local: args.local, token: 'pending',
    localToken: args['local-token'] || process.env.A2A_LOCAL_TOKEN,
    allowInsecure: !!args['allow-insecure'] });
  const card = await connector.discover(signal);
  const slug = card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
  const agentId = args['agent-id'] || previousAgentId || pending?.agentId || `${slug}-${randomBytes(4).toString('hex')}`;
  try {
    pending = await requestPairing({ relay: args.relay, agentId, name: card.name,
      allowInsecure: !!args['allow-insecure'], signal });
  } catch (error) {
    if (!error.message.includes('status 409')) throw error;
    await new Promise(resolve => setTimeout(resolve, 500));
    const concurrent = await existing(pendingPath, loadPendingPairing);
    if (!concurrent) throw error;
    return concurrent;
  }
  await saveEnrollment(pendingPath, pending);
  return pending;
}

function approvalURL(relay) {
  const url = new URL(relay);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/pair';
  return url.toString();
}

async function autoPair(args, path, signal) {
  let previousAgentId;
  for (;;) {
    let pending;
    try { pending = await ensurePairing(args, path, signal, previousAgentId); }
    catch (error) {
      if (signal.aborted) throw error;
      if (error.message.includes('status 409')) {
        throw new Error('another pairing request already uses this Agent ID; stop duplicate processes and inspect the pending state');
      }
      console.error(`Pairing request delayed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    previousAgentId = pending.agentId;
    console.log(`Pairing approval: ${approvalURL(args.relay)} | Agent: ${pending.agentId} | Confirmation: ${pending.confirmationCode}`);
    let result;
    try { result = await waitForPairing({ relay: args.relay, requestId: pending.requestId,
      allowInsecure: !!args['allow-insecure'], signal }); }
    catch (error) {
      if (signal.aborted) throw error;
      console.error(`Pairing status delayed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    if (result.status === 'expired') { await rm(path + '.pending', { force: true }); continue; }
    let enrollment;
    try { enrollment = await register({ relay: args.relay, code: result.code,
      allowInsecure: !!args['allow-insecure'], signal }); }
    catch (error) {
      if (signal.aborted) throw error;
      if (error.message.includes('status 401')) {
        throw new Error('pairing code rejected (401); inspect existing enrollment and private .state-* files before repairing the pending request');
      }
      throw new Error(`pairing registration outcome unknown (${error.message}); inspect enrollment and pending state before attempting another redemption`);
    }
    await saveEnrollment(path, enrollment);
    await rm(path + '.pending', { force: true });
    console.log(`Agent paired: ${enrollment.agentId} ${enrollment.card || ''}`);
    return enrollment;
  }
}

async function main() {
  const args = options(process.argv.slice(2));
  const path = await canonicalState(args.state || statePath());
  if (args.status) { console.log(JSON.stringify(await connectorStatus(path))); return; }
  // Read-only pairing inspection is safe while the running CLI owns the lock.
  if (args['request-only']) {
    const enrolled = await existing(path, loadEnrollment);
    const pending = enrolled ? null : await existing(path + '.pending', loadPendingPairing);
    if (enrolled) { console.log(JSON.stringify({ status: 'paired', agentId: enrolled.agentId })); return; }
    if (pending) { console.log(JSON.stringify({ status: 'pending', agentId: pending.agentId, confirmationCode: pending.confirmationCode, approvalURL: approvalURL(args.relay) })); return; }
  }
  const lock = await acquireStateLock(path, { parentInstance: process.env.A2A_HERMES_RUNNER_INSTANCE });
  try {
    const fingerprint = createHash('sha256').update(path).digest('hex').slice(0, 8);
    const label = basename(path).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
    process.title = `a2a-${fingerprint}-${label}`;
    const code = args['pair-code'] || process.env.A2A_PAIR_CODE;
    const controller = new AbortController();
    const managed = typeof process.send === 'function';
    const stopFromParent = message => { if (message?.type === 'hermes_shutdown') controller.abort(); };
    const parentDisconnected = () => controller.abort();
    if (managed) {
      process.on('message', stopFromParent);
      process.once('disconnect', parentDisconnected);
      if (!process.connected) controller.abort();
    }
    for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
    if (args['enroll-only'] && !code) throw new Error('pairing code is required');
    if (code) {
      const enrollment = await register({ relay: args.relay, code, allowInsecure: !!args['allow-insecure'] });
      await saveEnrollment(path, enrollment);
      await rm(path + '.pending', { force: true });
      console.log(`Agent paired: ${enrollment.agentId} ${enrollment.card || ''}`);
      if (args['enroll-only']) return;
    }
    if (args['request-only']) {
      const enrolled = await existing(path, loadEnrollment);
      if (enrolled) { console.log(JSON.stringify({ status: 'paired', agentId: enrolled.agentId })); return; }
      const pending = await ensurePairing(args, path, controller.signal);
      console.log(JSON.stringify({ status: 'pending', agentId: pending.agentId,
        confirmationCode: pending.confirmationCode, approvalURL: approvalURL(args.relay) }));
      return;
    }
    if (args['auto-pair'] && !args.token && !process.env.A2A_CONNECTOR_TOKEN &&
        !(await existing(path, loadEnrollment))) await autoPair(args, path, controller.signal);
    const token = args.token || process.env.A2A_CONNECTOR_TOKEN || (await loadEnrollment(path)).token;
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
  if (error.name !== 'AbortError') { console.error(`A2A Connector: ${error.message}`); process.exitCode = 1; }
  if (process.connected && typeof process.disconnect === 'function') process.disconnect();
});
