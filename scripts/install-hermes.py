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

SOURCE = Path(__file__).resolve().parents[1] / "plugins/hermes"


def install_hermes(home, python=sys.executable, env=None, run=subprocess.run):
    home = Path(home).expanduser().resolve()
    env = dict(os.environ if env is None else env, HERMES_HOME=str(home))
    detected = run([python, str(SOURCE / "a2a_support.py")], check=True,
                   capture_output=True, text=True, timeout=20, env=env)
    selected = json.loads(detected.stdout)
    if selected.get("mode") not in ("native", "existing", "compat"):
        raise ValueError("Invalid Hermes A2A capability result")
    target = home / "plugins/a2a-connector"
    if target.exists():
        raise ValueError("Connector directory already exists; stop the old Connector and move its backup outside plugins/ before installing")
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
        target.parent.mkdir(parents=True, exist_ok=True)
        # Rename the complete tree into place; an existing nonempty plugin is never replaced.
        plugin.rename(target)
    return selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", default=os.environ.get("HERMES_HOME", "~/.hermes"),
                        help="Active Hermes/profile home")
    parser.add_argument("--hermes-python", default=sys.executable, help="Python interpreter used by this Hermes installation")
    parser.add_argument("--hermes-root", help="Hermes source root when not installed as an importable package")
    parser.add_argument("--local", default=os.environ.get("A2A_LOCAL_URL", "auto"))
    args = parser.parse_args()
    env = dict(os.environ, A2A_LOCAL_URL=args.local)
    if args.hermes_root:
        root = str(Path(args.hermes_root).expanduser().resolve())
        env["PYTHONPATH"] = root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    selected = install_hermes(args.home, args.hermes_python, env)
    print("Installed Connector and compatibility A2A." if selected["mode"] == "compat"
          else "Installed Connector only; using existing Hermes A2A at " + selected["local"])
    print("Enable a2a-connector in the target profile and configure its environment; see docs/install/hermes.md.")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print((error.stderr or "Hermes A2A detection failed").strip(), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print("Hermes A2A installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
