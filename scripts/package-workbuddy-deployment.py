#!/usr/bin/env python3
"""Bundle explicit, public deployment inputs; never include local configuration."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
relay = root.parent / "a2a-relay"
version = json.loads((root / "package.json").read_text())["version"]
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "dist"
output.mkdir(parents=True, exist_ok=True)
for builder in ("package-workbuddy.py", "package-workbuddy-mcp.py"):
    subprocess.run([sys.executable, str(root / "scripts" / builder), str(output)], check=True)

files = {
    "relay/relay-linux-amd64": relay / "dist/relay-linux-amd64",
    "relay/relay-linux-arm64": relay / "dist/relay-linux-arm64",
    "relay/relay.example.json": relay / "deploy/relay.example.json",
    "relay/chuanbota-relay.service": relay / "deploy/chuanbota-relay.service",
    "relay/nginx-workbuddy.conf": relay / "deploy/nginx-workbuddy.conf",
    "scripts/workbuddy-config.py": relay / "scripts/workbuddy-config.py",
    "scripts/check-workbuddy-deployment.py": relay / "scripts/check-workbuddy-deployment.py",
    "workbuddy/chuanbota-workbuddy.service": root / "deploy/chuanbota-workbuddy.service",
    f"workbuddy/workbuddy-a2a-connector-{version}.zip": output / f"workbuddy-a2a-connector-{version}.zip",
    f"workbuddy/chuanbota-a2a-mcp-{version}.zip": output / f"chuanbota-a2a-mcp-{version}.zip",
    "workbuddy-mcp.md": root / "docs/install/workbuddy-mcp.md",
    "INSTALL.md": root / "deploy/workbuddy-install.md",
}
payloads = {}
for name, source in files.items():
    if source.is_symlink() or not source.is_file():
        raise SystemExit(f"Missing regular deployment input: {source}")
    payloads[name] = source.read_bytes()
# The source guide lives under docs/install; the bundle keeps both guides at its root.
payloads["workbuddy-mcp.md"] = payloads["workbuddy-mcp.md"].replace(
    b"../../deploy/workbuddy-install.md", b"INSTALL.md")
for arch, machine in (("amd64", 62), ("arm64", 183)):
    data = payloads[f"relay/relay-linux-{arch}"]
    if data[:6] != b"\x7fELF\x02\x01" or int.from_bytes(data[18:20], "little") != machine:
        raise SystemExit(f"Wrong Linux binary architecture: {arch}")
checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(payloads.items()))
payloads["SHA256SUMS"] = checksums.encode()
archive_path = output / f"chuanbota-workbuddy-deployment-{version}.tar.gz"
prefix = f"chuanbota-workbuddy-{version}"
with tarfile.open(archive_path, "w:gz") as archive:
    for name, data in sorted(payloads.items()):
        entry = tarfile.TarInfo(f"{prefix}/{name}")
        entry.size = len(data)
        entry.mode = 0o755 if name.startswith("scripts/") or name.startswith("relay/relay-linux-") else 0o644
        archive.addfile(entry, io.BytesIO(data))
with tarfile.open(archive_path, "r:gz") as archive:
    assert set(archive.getnames()) == {f"{prefix}/{name}" for name in payloads}
    for name, data in payloads.items():
        assert archive.extractfile(f"{prefix}/{name}").read() == data
print(archive_path)
print(f"Verified {len(payloads)} allowlisted files; no private env, runtime state or live Redis configuration included")
