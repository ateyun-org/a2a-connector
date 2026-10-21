#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startReceiver } from './receiver-runtime.js';

async function main() {
  const [settingsPath, state] = process.argv.slice(2);
  if (!settingsPath || !state) throw new Error('WorkBuddy runner requires settings and state paths');
  const c = JSON.parse(await readFile(settingsPath, 'utf8'));
  const stopped = new Promise(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
  });
  process.title = `workbuddy-a2a-${createHash('sha256').update(state).digest('hex').slice(0, 8)}`;
  const receiver = await startReceiver(c, state);
  try {
    console.log(`WorkBuddy ${c.adapter} adapter listening on ${receiver.local}; waiting for pairing and OAuth authorization`);
    if (process.send) process.send({ type: 'workbuddy_ready', local: receiver.local });
    await stopped;
  } finally { await receiver.close(); }
}

main().catch(() => {
  console.error('WorkBuddy runner failed; check settings, journal permissions, and dependency installation');
  if (process.send) process.send({ type: 'workbuddy_start_failed' }, () => process.exit(78));
  else process.exit(78);
});
