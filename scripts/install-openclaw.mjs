#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { selectA2A } from '../plugins/openclaw/a2a-selection.js';

const run = promisify(execFile);
const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'openclaw');

// Native installations carry only the Connector; legacy installations also carry the adapter.
export async function installOpenClaw({ config = {}, hostConfig = {}, token,
  execute = run, fetcher = fetch } = {}) {
  const selected = await selectA2A({ config, hostConfig, token, execute, fetcher });
  const stage = await mkdtemp(join(tmpdir(), 'a2a-openclaw-'));
  const plugin = join(stage, 'plugin');
  try {
    await cp(source, plugin, { recursive: true, filter: path => {
      const relative = path.slice(source.length + 1);
      if (relative === 'node_modules' || relative.startsWith('node_modules/')) return false;
      return selected.mode === 'compat' || !['adapter-server.js', 'agent-driver.js'].includes(relative);
    } });
    await execute('npm', ['ci', '--omit=dev', '--omit=peer', '--ignore-scripts', '--prefix', plugin],
      { timeout: 120000, maxBuffer: 1024 * 1024 });
    await execute(config.openclawBinary || 'openclaw',
      [...(config.openclawArgs || []), 'plugins', 'install', plugin],
      { timeout: 120000, maxBuffer: 1024 * 1024 });
    return selected;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function main() {
  const flags = {};
  const names = new Set(['--openclaw-binary', '--profile', '--gateway-port', '--local', '--local-token-env']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!names.has(args[i]) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    flags[args[i]] = args[i + 1];
  }
  const port = Number(flags['--gateway-port'] || 18789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --gateway-port');
  const token = flags['--local-token-env'] ? process.env[flags['--local-token-env']] : undefined;
  if (flags['--local-token-env'] && !token) throw new Error('Local token environment variable is unset');
  const selected = await installOpenClaw({ config: {
    local: flags['--local'] || 'auto', openclawBinary: flags['--openclaw-binary'] || 'openclaw',
    openclawArgs: flags['--profile'] ? ['--profile', flags['--profile']] : [],
  }, hostConfig: { gateway: { port } }, token });
  console.log(selected.mode === 'compat'
    ? 'Installed Connector and compatibility A2A for this legacy OpenClaw.'
    : `Installed Connector only; using existing A2A at ${selected.local}.`);
  console.log('Merge the plugin configuration from docs/install/openclaw.md, then enable a2a-connector.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`OpenClaw A2A installation failed: ${error.message}`); process.exitCode = 1; });
}
