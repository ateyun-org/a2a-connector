import { cpSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const plugin of ['openclaw', 'hermes', 'dsh', 'workbuddy']) {
  const vendor = join(root, 'plugins', plugin, 'vendor', 'connector');
  mkdirSync(vendor, { recursive: true });
  for (const file of ['cli.js', 'connector.js', 'state-lock.js', 'process-supervisor.js']) copyFileSync(join(root, 'src', file), join(vendor, file));
  writeFileSync(join(vendor, 'package.json'), '{"type":"module"}\n');
  if (plugin === 'hermes') {
    const modules = join(vendor, 'node_modules');
    mkdirSync(modules, { recursive: true });
    cpSync(join(root, 'node_modules', 'ws'), join(modules, 'ws'), { recursive: true, force: true });
  }
}
console.log('Synced JavaScript Connector into four host plugins');
