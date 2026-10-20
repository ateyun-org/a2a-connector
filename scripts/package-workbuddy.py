#!/usr/bin/env python3
"""Build a CLI + Skill submission ZIP, excluding local state and dependencies."""
import json
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
plugin = root / 'plugins' / 'workbuddy'
package = json.loads((plugin / 'package.json').read_text())
metadata = json.loads((plugin / 'connector-meta.json').read_text())
cli = json.loads((plugin / 'cli.json').read_text())
assert metadata['type'] == 'cli' and metadata['version'] == package['version']
assert cli['runtime'] == {'type': 'node', 'version': '22'}
for platform in ('darwin', 'linux'):
    assert cli['auth'][platform] == 'workbuddy-a2a auth connect'
    assert platform in cli['init'] and platform in cli['status'] and platform in cli['unAuth']
assert all(field in metadata for field in ('description', 'description_zh', 'description_en'))

output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'dist'
output.mkdir(parents=True, exist_ok=True)
path = output / f'workbuddy-a2a-connector-{package["version"]}.zip'
files = list(plugin.glob('*.js')) + list(plugin.glob('*.json')) + [plugin / 'icon.svg']
files += list((plugin / 'skills').rglob('*.md'))
files += list((plugin / 'vendor' / 'connector').glob('*.js'))
files += list((plugin / 'vendor' / 'connector').glob('*.json'))
required = {'cli.js', 'runner.js', 'adapter-server.js', 'desktop-api.js', 'desktop-bridge.js',
            'cloud-api.js', 'cloud-bridge.js', 'acp-client.js',
            'task-store.js', 'connector-meta.json', 'cli.json', 'package.json', 'icon.svg',
            'skills/a2a-connector/SKILL.md', 'vendor/connector/cli.js', 'vendor/connector/connector.js'}
names = {str(file.relative_to(plugin)) for file in files}
assert required <= names, f'Missing package files: {required - names}'
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(set(files)):
        archive.write(file, file.relative_to(plugin))
print(path)
print(f'Validated {len(names)} files; no credentials or node_modules included')
