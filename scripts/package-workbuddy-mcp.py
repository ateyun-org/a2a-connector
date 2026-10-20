#!/usr/bin/env python3
"""Build the remote MCP connector submission, with no runtime or credentials."""
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
plugin = root / "plugins" / "workbuddy-mcp"
metadata = json.loads((plugin / "connector-meta.json").read_text())
version = json.loads((root / "package.json").read_text())["version"]
assert metadata["version"] == version and metadata["type"] == "mcp"
config = json.loads((plugin / "mcp.json").read_text())
assert len(config["mcpServers"]) == 1
server = next(iter(config["mcpServers"].values()))
assert server["type"] == "streamableHttp" and server["url"].startswith("https://")
assert "headers" not in server and "env" not in server
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "dist"
output.mkdir(parents=True, exist_ok=True)
path = output / f"chuanbota-a2a-mcp-{version}.zip"
files = [plugin / "connector-meta.json", plugin / "mcp.json", plugin / "icon.svg"]
files += list((plugin / "skills").rglob("SKILL.md"))
assert all(file.is_file() for file in files)
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(files):
        archive.write(file, file.relative_to(plugin))
print(path)
print(f"Validated {len(files)} files; OAuth is discovered remotely; no secrets included")
