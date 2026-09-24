#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Connector, loadEnrollment, loadPendingPairing, pairingStatus, register, requestPairing,
  saveEnrollment, statePath, waitForPairing } from './connector.js';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^-+/, '');
    if (['allow-insecure', 'enroll-only', 'auto-pair', 'request-only'].includes(key)) result[key] = true;
    else if (['relay', 'local', 'token', 'local-token', 'state', 'pair-code', 'agent-id'].includes(key)) result[key] = argv[++i];
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
      if (error.message.includes('status 401')) await rm(path + '.pending', { force: true });
      console.error(`Pairing registration delayed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    await saveEnrollment(path, enrollment);
    await rm(path + '.pending', { force: true });
    console.log(`Agent paired: ${enrollment.agentId} ${enrollment.card || ''}`);
    return enrollment;
  }
}

async function main() {
  const args = options(process.argv.slice(2));
  const path = args.state || statePath();
  const code = args['pair-code'] || process.env.A2A_PAIR_CODE;
  const controller = new AbortController();
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
    localToken: args['local-token'] || process.env.A2A_LOCAL_TOKEN,
    allowInsecure: !!args['allow-insecure'] });
  await connector.run(controller.signal);
}

main().catch(error => { console.error(`A2A Connector: ${error.message}`); process.exitCode = 1; });
