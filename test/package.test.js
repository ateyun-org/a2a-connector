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

test('DSH plugin package name matches Cordis patch documentation', async () => {
  const dshPkg = JSON.parse(await readFile(join('plugins', 'dsh', 'package.json'), 'utf8'));
  assert.equal(dshPkg.name, 'dsh-a2a-connector');
  const dshInstall = await readFile(join('docs', 'install', 'dsh.md'), 'utf8');
  assert.match(dshInstall, /name:\s*dsh-a2a-connector/);
});


test('DSH SDKs remain host-provided peer dependencies', async () => {
  const pkg = JSON.parse(await readFile('plugins/dsh/package.json', 'utf8'));
  for (const name of ['dsh-tools', 'schemastery', 'dsh-agent', 'dsh-llm']) {
    const dependency = `@deepseek-ai/${name}`;
    assert.ok(pkg.peerDependencies[dependency], `${dependency} must be a peer`);
    assert.equal(pkg.dependencies?.[dependency], undefined);
    assert.equal(pkg.optionalDependencies?.[dependency], undefined);
  }
});

test('all package.json versions and plugin manifests match root version', async () => {
  const rootPkg = JSON.parse(await readFile('package.json', 'utf8'));
  for (const host of ['openclaw', 'dsh', 'workbuddy']) {
    const pkg = JSON.parse(await readFile(join('plugins', host, 'package.json'), 'utf8'));
    assert.equal(pkg.version, rootPkg.version, `${host} package.json version should match root version`);
  }
  const workbuddyMeta = JSON.parse(await readFile(join('plugins', 'workbuddy', 'connector-meta.json'), 'utf8'));
  assert.equal(workbuddyMeta.version, rootPkg.version, 'workbuddy connector-meta.json version should match root version');
  const hermesYaml = await readFile(join('plugins', 'hermes', 'plugin.yaml'), 'utf8');
  assert.match(hermesYaml, new RegExp(`^version:\\s*${rootPkg.version}`, 'm'), 'hermes plugin.yaml version should match root version');
});
