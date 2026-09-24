import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('host plugins carry the current JavaScript Connector', async () => {
  for (const file of ['cli.js', 'connector.js']) {
    const source = await readFile(join('src', file));
    for (const host of ['openclaw', 'hermes', 'dsh', 'workbuddy']) {
      assert.deepEqual(await readFile(join('plugins', host, 'vendor', 'connector', file)), source,
        `${host} has an outdated ${file}; run node scripts/sync-plugins.mjs`);
    }
  }
  const hermesWS = JSON.parse(await readFile('plugins/hermes/vendor/connector/node_modules/ws/package.json', 'utf8'));
  assert.equal(hermesWS.name, 'ws');
});
