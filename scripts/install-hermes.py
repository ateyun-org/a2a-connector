#!/usr/bin/env python3
"""Install the Connector, including compatibility A2A only when Hermes lacks it."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from uuid import uuid4

SOURCE = Path(__file__).resolve().parents[1] / "plugins/hermes"


def install_hermes(home, python=sys.executable, env=None, run=subprocess.run, node=None, relay=None, state=None, check=False, upgrade=False):
    home = Path(home).expanduser().resolve()
    env = dict(os.environ if env is None else env, HERMES_HOME=str(home))
    target = home / "plugins/a2a-connector"
    previous = {}
    if upgrade and target.exists() and (target / "connector-config.json").is_file():
        previous = json.loads((target / "connector-config.json").read_text(encoding="utf-8"))
        if not isinstance(previous, dict) or any(not isinstance(v, str) for v in previous.values()):
            raise ValueError("Invalid existing Connector settings")
        if previous.get("A2A_LOCAL_URL"):
            env.setdefault("A2A_LOCAL_URL", previous["A2A_LOCAL_URL"])
    # Installation decides packaging from source capability; health is checked at runtime.
    detected = run([python, str(SOURCE / "a2a_support.py"), "--inspect"], check=True,
                   capture_output=True, text=True, timeout=20, env=env)
    selected = json.loads(detected.stdout)
    if selected.get("mode") not in ("native", "existing", "compat"):
        raise ValueError("Invalid Hermes A2A capability result")
    binary = shutil.which(node or env.get("A2A_NODE_BINARY") or "node")
    if not binary:
        raise ValueError("Node executable not found; pass --node with the actual native path (do not guess its drive)")
    version = run([binary, "--version"], check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    if not version.startswith("v") or int(version[1:].split(".")[0]) < 22:
        raise ValueError("Node.js 22 or newer is required")
    if relay:
        from urllib.parse import urlsplit
        url = urlsplit(relay)
        if url.scheme != "wss" or not url.hostname or url.path != "/connect" or url.username or url.password or url.query or url.fragment:
            raise ValueError("--relay must be a WSS /connect URL without credentials")
    if check:
        return dict(selected, node=binary, nodeVersion=version)
    if target.exists() and not upgrade:
        raise ValueError("Connector directory already exists; stop the old Connector and move its backup outside plugins/ before installing")
    if target.exists():
        manifest = target / "plugin.yaml"
        if not manifest.is_file() or "name: a2a-connector" not in manifest.read_text(encoding="utf-8").splitlines():
            raise ValueError("Existing target is not a verified a2a-connector plugin; refusing to replace it")
        managed_state = state or previous.get("A2A_CONNECTOR_STATE") or env.get("A2A_CONNECTOR_STATE")
        if not managed_state:
            raise ValueError("Upgrade requires --state with the existing actual state path; do not guess another profile's state")
        managed_state = Path(managed_state).expanduser().resolve()
        if target == managed_state or target in managed_state.parents:
            raise ValueError("Move the state outside the plugin directory before upgrading")
        # New runners can shut down in place; legacy or orphaned locks fail closed.
        run([binary, str(SOURCE / "runner.js"), "-state", str(managed_state), "-stop"],
            check=True, capture_output=True, text=True, timeout=20, env=env)
    # Detection is complete before creating directories or replacing any plugin.
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".a2a-install-", dir=home) as stage:
        plugin = Path(stage) / "a2a-connector"
        def excluded(directory, names):
            skip = {name for name in names if name == "__pycache__" or name.endswith(".pyc")}
            if Path(directory) == SOURCE and selected["mode"] != "compat":
                skip.update(("adapter-server.js", "agent-driver.js"))
            return skip
        shutil.copytree(SOURCE, plugin, ignore=excluded)
        hints = {"python": selected.get("python", python), "node": str(Path(binary).resolve()),
                 "home": str(home), "hermesRoot": selected.get("hermesRoot", "")}
        (plugin / "host-runtime.json").write_text(json.dumps(hints), encoding="utf-8")
        config = {k: v for k, v in previous.items() if k in ("A2A_RELAY_URL", "A2A_CONNECTOR_STATE", "A2A_AGENT_ID")}
        config.update({"A2A_NODE_BINARY": hints["node"], "A2A_LOCAL_URL": env.get("A2A_LOCAL_URL", "auto")})
        if relay:
            config["A2A_RELAY_URL"] = relay
        if state:
            config["A2A_CONNECTOR_STATE"] = str(Path(state).expanduser().resolve())
        (plugin / "connector-config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Rename the complete tree into place; an existing nonempty plugin is never replaced.
        backup = home / ("a2a-connector.backup-" + uuid4().hex[:12]) if target.exists() else None
        if backup:
            target.rename(backup)
        try:
            plugin.rename(target)
        except BaseException:
            if backup and not target.exists():
                backup.rename(target)
            raise
        if backup:
            selected["backup"] = str(backup)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", default=os.environ.get("HERMES_HOME", "~/.hermes"),
                        help="Active Hermes/profile home")
    parser.add_argument("--hermes-python", default=sys.executable, help="Python interpreter used by this Hermes installation")
    parser.add_argument("--hermes-root", help="Hermes source root when not installed as an importable package")
    parser.add_argument("--local", help="Explicit local origin or auto; upgrade preserves existing non-secret settings by default")
    parser.add_argument("--node", help="Actual Node.js 22+ executable; otherwise discover it from PATH")
    parser.add_argument("--relay", help="Save the Relay WSS /connect URL in the plugin's non-secret settings")
    parser.add_argument("--state", help="Private Connector state path")
    parser.add_argument("--check", action="store_true", help="Preflight Python, Node and host capability without installing or contacting Relay")
    parser.add_argument("--upgrade", action="store_true", help="Stop a managed existing runner and back up the old plugin outside plugins/ before replacing it")
    args = parser.parse_args()
    env = dict(os.environ)
    if args.local:
        env["A2A_LOCAL_URL"] = args.local
    if args.hermes_root:
        root = str(Path(args.hermes_root).expanduser().resolve())
        env["PYTHONPATH"] = root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    selected = install_hermes(args.home, args.hermes_python, env, node=args.node, relay=args.relay, state=args.state, check=args.check, upgrade=args.upgrade)
    if args.check:
        print(json.dumps(selected))
        return
    print("Installed Connector and compatibility A2A." if selected["mode"] == "compat"
          else "Installed Connector only; selected Hermes A2A at " + selected["local"] + " (health not yet checked)")
    print("Enable a2a-connector and native A2A if present; load all Gateway changes once from an outside shell, then run /a2a_connector doctor and pair. See docs/install/hermes.md.")
    if selected.get("backup"):
        print("Previous plugin backup: " + selected["backup"] + "; existing credentials preserved")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print((error.stderr or "Hermes A2A detection failed").strip(), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Hermes A2A installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
