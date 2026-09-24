#!/usr/bin/env node
import { Connector, loadEnrollment, register, saveEnrollment, statePath } from './connector.js';

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^-+/, '');
    if (key === 'allow-insecure' || key === 'enroll-only') result[key] = true;
    else if (['relay', 'local', 'token', 'local-token', 'state', 'pair-code'].includes(key)) result[key] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return result;
}

async function main() {
  const args = options(process.argv.slice(2));
  const path = args.state || statePath();
  const code = args['pair-code'] || process.env.A2A_PAIR_CODE;
  if (args['enroll-only'] && !code) throw new Error('pairing code is required');
  if (code) {
    const enrollment = await register({ relay: args.relay, code, allowInsecure: !!args['allow-insecure'] });
    await saveEnrollment(path, enrollment);
    console.log(`Agent paired: ${enrollment.agentId} ${enrollment.card || ''}`);
    if (args['enroll-only']) return;
  }
  const token = args.token || process.env.A2A_CONNECTOR_TOKEN || (await loadEnrollment(path)).token;
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  const connector = new Connector({ relay: args.relay, local: args.local, token,
    localToken: args['local-token'] || process.env.A2A_LOCAL_TOKEN,
    allowInsecure: !!args['allow-insecure'] });
  await connector.run(controller.signal);
}

main().catch(error => { console.error(`A2A Connector: ${error.message}`); process.exitCode = 1; });
