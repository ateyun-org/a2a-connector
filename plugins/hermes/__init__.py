"""Hermes Connector tools, commands and standalone lifecycle CLI."""
import importlib.util
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

_ROOT = Path(__file__).resolve().parent
# Hermes loads this file with spec_from_file_location, without a package name.
_spec = importlib.util.spec_from_file_location("hermes_connector_host_support", _ROOT / "host_support.py")
_host = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_host)


def _config():
    path = _ROOT / "connector-config.json"
    if not path.exists():
        return {}
    config = json.loads(path.read_text(encoding="utf-8"))
    allowed = {"A2A_RELAY_URL", "A2A_LOCAL_URL", "A2A_NODE_BINARY", "A2A_CONNECTOR_STATE", "A2A_AGENT_ID"}
    if not isinstance(config, dict) or any(k not in allowed or not isinstance(v, str) for k, v in config.items()):
        raise ValueError("Invalid connector-config.json; use only documented non-secret Connector settings")
    return config


def _environment():
    # Dedicated non-secret settings can be changed without restarting the Gateway.
    return dict(os.environ, **_config())


def _settings():
    env = _environment()
    state = Path(env.get("A2A_CONNECTOR_STATE", "~/.config/a2a-connector/hermes.json")).expanduser().resolve()
    hints = {}
    path = _ROOT / "host-runtime.json"
    if path.is_file():
        hints = json.loads(path.read_text(encoding="utf-8"))
    node = env.get("A2A_NODE_BINARY") or hints.get("node") or "node"
    return node, str(_ROOT / "runner.js"), env.get("A2A_RELAY_URL", ""), env.get("A2A_LOCAL_URL", "auto"), state


def _runtime_env():
    env = _environment()
    env["A2A_HERMES_PYTHON"] = sys.executable
    hints = {}
    path = _ROOT / "host-runtime.json"
    if path.is_file():
        hints = json.loads(path.read_text(encoding="utf-8"))
    if hints.get("home"):
        env.setdefault("HERMES_HOME", hints["home"])
    spec = importlib.util.find_spec("hermes_cli")
    root = str(Path(spec.origin).resolve().parent.parent) if spec and spec.origin else hints.get("hermesRoot")
    if root:
        env["PYTHONPATH"] = root + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    return env


def _args(require_relay=True):
    node, script, relay, local, state = _settings()
    if require_relay and not relay.strip():
        raise ValueError("Missing environment variable: A2A_RELAY_URL; configure connector-config.json or the host environment")
    binary = shutil.which(node)
    if not binary:
        raise OSError(f"Node executable not found: {node!r}; verify A2A_NODE_BINARY in this Hermes process")
    for path in (Path(script), _ROOT / "vendor/connector/cli.js"):
        if not path.is_file():
            raise OSError("Bundled Connector CLI is missing; reinstall the complete Hermes plugin directory")
    args = [binary, script, "-relay", relay, "-local", local, "-state", str(state)]
    env = _environment()
    if env.get("A2A_AGENT_ID"):
        args.extend(["-agent-id", env["A2A_AGENT_ID"]])
    if env.get("A2A_ALLOW_INSECURE") == "1":
        args.append("-allow-insecure")
    return args


def _run(args, timeout=30):
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, encoding="utf-8",
                              timeout=timeout, env=_runtime_env(), **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
    except subprocess.CalledProcessError as error:
        # Child stderr may contain host/Relay response bodies. Keep it in the private log.
        state = _settings()[-1]
        fd = _host.private_open(_log_path(state), os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        with os.fdopen(fd, "w", encoding="utf-8") as log:
            log.write(error.stderr or "")
        raise subprocess.SubprocessError(f"Connector command failed (exit {error.returncode}); inspect private log: {_log_path(state)}") from error


def _status():
    return json.loads(_run(_args(require_relay=False) + ["-status"]).stdout)


def _log_path(state):
    return state.with_suffix(".stderr.log")


def _self_check_once():
    logger = logging.getLogger(__name__)
    try:
        _args()
    except (OSError, ValueError) as error:
        logger.error("A2A Connector self-check failed: %s. Fix Connector settings/files, then retry start. "
                     "If changing the host .env or plugin registration, restart the Gateway from an outside shell.", error)
        return
    state = _settings()[-1]
    if state.is_file():
        logger.info("A2A Connector self-check: configuration present; pairing state exists (not validated). "
                    "Connectivity is not yet verified. stderr: %s", _log_path(state))
    elif Path(str(state) + ".pending").is_file():
        logger.warning("A2A Connector self-check: configuration present; request pending. "
                       "Use a2a_connector_pair for approval details. stderr: %s", _log_path(state))
    else:
        logger.warning("A2A Connector self-check: configuration present; not yet paired. "
                       "Missing pairing state does not block startup. stderr: %s", _log_path(state))


def _start():
    args = _args()
    state = _settings()[-1]
    _host.secure_state(state)
    status = _status()
    if status.get("running"):
        return "A2A Connector process is already running; use a2a_connector_status to check tunnel health"
    fd = _host.private_open(_log_path(state), os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    # Windows detachment is managed by IPC/files, never by Python os.kill(pid, 0).
    options = ({"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
               if os.name == "nt" else {"start_new_session": True})
    with os.fdopen(fd, "ab") as log:
        process = subprocess.Popen(args + ["-auto-pair"], stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=log, env=_runtime_env(), **options)
    try:
        try:
            code = process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            pass
        else:
            if _status().get("running"):
                return "A2A Connector process is already running; use a2a_connector_status to check tunnel health"
            raise subprocess.SubprocessError(f"Connector exited during startup (status {code}); inspect private log: {_log_path(state)}")
        # Wait for a controllable owner before publishing the advisory PID file.
        # If writing that file fails, stop can now reliably reach this wrapper.
        deadline = time.monotonic() + 8
        while True:
            status = _status()
            if status.get("running"):
                if status.get("pid") != process.pid:
                    return "A2A Connector process is already running; use a2a_connector_status to check tunnel health"
                break
            if process.poll() is not None or time.monotonic() >= deadline:
                raise subprocess.SubprocessError(f"Connector did not publish a controllable owner; inspect private log: {_log_path(state)}")
            time.sleep(0.1)
        fd = _host.private_open(state.with_suffix(".pid"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(str(process.pid))
    except BaseException:
        # Ask the wrapper to clean up; never terminate just its Windows parent.
        if process.poll() is None:
            try:
                _stop()
            except (OSError, ValueError, subprocess.SubprocessError):
                logging.getLogger(__name__).error("Failed startup cleanup; inspect private log: %s", _log_path(state))
        raise
    return f"A2A Connector process started; pairing/connectivity not yet verified. stderr: {_log_path(state)}"


def _stop():
    _run(_args(require_relay=False) + ["-stop"], timeout=20)
    _settings()[-1].with_suffix(".pid").unlink(missing_ok=True)
    return "A2A Connector stopped"


def _pair(code=""):
    if code:
        if not code.startswith("pair_"):
            raise ValueError("Invalid pairing code")
        _stop()
        env = _runtime_env()
        env["A2A_PAIR_CODE"] = code
        try:
            subprocess.run(_args() + ["-enroll-only"], check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE, timeout=30, env=env)
        except subprocess.CalledProcessError as error:
            raise subprocess.SubprocessError("Pairing redemption failed; inspect the Relay approval before retrying") from error
    _start()
    # Only the managed long-running CLI creates/renews requests and redeems approvals.
    deadline = time.monotonic() + 25
    while True:
        status = _status()
        if status.get("paired"):
            return json.dumps({"status": "paired", "agentId": status.get("agentId"),
                               "connected": status.get("tunnelOnline", False)})
        pairing = status.get("pairing")
        if pairing and status.get("running") and status.get("phase") == "running":
            url = _environment().get("A2A_RELAY_URL", "")
            from urllib.parse import urlsplit, urlunsplit
            origin = urlsplit(url)
            pairing["approvalURL"] = urlunsplit(("https" if origin.scheme == "wss" else "http", origin.netloc, "/pair", "", ""))
            if pairing.get("expiresAt", 0) > time.time():
                return json.dumps(pairing)
        if not status.get("running"):
            raise subprocess.SubprocessError(f"Connector stopped before pairing was ready; inspect private log: {_log_path(_settings()[-1])}")
        if time.monotonic() >= deadline:
            return json.dumps({"status": "starting", "running": True, "diagnostic": "Check a2a_connector_status and the private log; no approval is ready yet"})
        time.sleep(0.2)


def _doctor():
    args = _args(require_relay=False)
    version = _run([args[0], "--version"]).stdout.strip()
    if not version.startswith("v") or int(version[1:].split(".")[0]) < 22:
        raise ValueError("Node.js 22 or newer is required")
    capability = json.loads(_run([sys.executable, str(_ROOT / "a2a_support.py"), "--inspect"]).stdout)
    _, _, relay, local, state = _settings()
    return {"node": args[0], "nodeVersion": version, "python": sys.executable,
            "state": str(state), "pidFile": str(state.with_suffix(".pid")), "logFile": str(_log_path(state)),
            "relayConfigured": bool(relay), "local": local, "capability": capability["mode"],
            "health": _status()}


def _tool(args, **kwargs):
    try:
        return _pair(args.get("code", ""))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return json.dumps({"error": str(error)})


def _command(raw_args):
    parts = raw_args.strip().split(maxsplit=1)
    try:
        if parts and parts[0] == "pair":
            return _pair(parts[1] if len(parts) == 2 else "")
        if parts == ["start"]:
            return _start()
        if parts == ["stop"]:
            return _stop()
        if parts == ["status"]:
            return json.dumps(_status())
        if parts == ["doctor"]:
            return json.dumps(_doctor())
        return "Usage: /a2a_connector pair [pair_code] | start | stop | status | doctor"
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return f"A2A Connector error: {error}"


def register(ctx):
    if os.environ.get("A2A_CONNECTOR_CHILD") == "1":
        return
    _self_check_once()
    schema = {"name": "a2a_connector_pair", "description": "Start the managed Connector and show its active pairing approval; no Gateway restart. Optionally redeem a manual pair_ code.",
              "parameters": {"type": "object", "properties": {"code": {"type": "string"}}}}
    ctx.register_tool(name="a2a_connector_pair", toolset="a2a_connector", schema=schema, handler=_tool)
    ctx.register_tool(name="a2a_connector_status", toolset="a2a_connector",
                      schema={"name": "a2a_connector_status", "description": "Read Connector process, pairing and live tunnel health without restarting or changing anything.", "parameters": {"type": "object", "properties": {}}},
                      handler=lambda *_args, **_kwargs: _command("status"))
    ctx.register_command("a2a_connector", handler=_command, description="Pair, start, stop, inspect or diagnose the Connector")
    def on_session_start(**kwargs):
        try:
            logging.getLogger(__name__).info("%s", _start())
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            logging.getLogger(__name__).error("A2A Connector startup failed: %s. Run /a2a_connector doctor; fix the reported settings/files, then retry Connector start.", error)
    ctx.register_hook("on_session_start", on_session_start)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    result = _command(" ".join(sys.argv[1:]))
    print(result)
    if result.startswith("A2A Connector error:"):
        raise SystemExit(1)
