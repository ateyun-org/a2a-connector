"""Hermes A2A Connector plugin."""

import json
import logging
import os
from pathlib import Path
import signal
import shutil
import subprocess


def _settings():
    state = Path(os.environ.get("A2A_CONNECTOR_STATE", "~/.config/a2a-connector/hermes.json")).expanduser()
    node = os.environ.get("A2A_NODE_BINARY", "node")
    script = Path(__file__).parent / "vendor" / "connector" / "cli.js"
    return (node, str(script),
            os.environ.get("A2A_RELAY_URL", ""),
            os.environ.get("A2A_LOCAL_URL", ""), state)


def _args():
    binary, script, relay, local, state = _settings()
    missing = [name for name, value in (("A2A_RELAY_URL", relay), ("A2A_LOCAL_URL", local)) if not value.strip()]
    if missing:
        raise ValueError("Missing environment variables: " + ", ".join(missing))
    args = [binary, script, "-relay", relay, "-local", local, "-state", str(state)]
    if os.environ.get("A2A_AGENT_ID"):
        args.extend(["-agent-id", os.environ["A2A_AGENT_ID"]])
    if os.environ.get("A2A_ALLOW_INSECURE") == "1":
        args.append("-allow-insecure")
    return args


def _pair(code):
    if not code:
        result = subprocess.run(_args() + ["-request-only"], check=True,
                                capture_output=True, text=True, timeout=20)
        _start()
        return result.stdout.strip()
    if not code.startswith("pair_"):
        raise ValueError("Invalid pairing code")
    _, _, _, _, state = _settings()
    env = dict(os.environ, A2A_PAIR_CODE=code)
    subprocess.run(_args() + ["-enroll-only"], check=True, env=env,
                   stdout=subprocess.DEVNULL, timeout=20)
    _stop()
    _start()
    return json.dumps({"agentId": json.loads(state.read_text())["agentId"], "connected": True})


def _pid(pid_path):
    pid = int(pid_path.read_text())
    if pid <= 1:
        raise ValueError("Invalid Connector PID")
    return pid


def _log_path(state):
    return state.with_suffix(".stderr.log")


def _self_check_once():
    """Report local prerequisites at registration; never pair or start a process."""
    logger = logging.getLogger(__name__)
    try:
        args = _args()
        if not shutil.which(args[0]):
            raise OSError("Node executable not found; set A2A_NODE_BINARY to an executable Node.js 22+ path")
        if not Path(args[1]).is_file():
            raise OSError("Bundled Connector CLI is missing; reinstall the complete Hermes plugin directory")
    except (OSError, ValueError) as error:
        logger.error("A2A Connector self-check failed: %s. Configure the active Gateway/profile environment "
                     "(normally its .env), then restart the Gateway. Connector cannot start until resolved.", error)
        return
    _, _, _, _, state = _settings()
    if state.is_file():
        logger.info("A2A Connector self-check: configuration present; pairing state exists (not validated). "
                    "Connectivity is not yet verified. stderr: %s", _log_path(state))
    elif Path(str(state) + ".pending").is_file():
        logger.warning("A2A Connector self-check: configuration present; pairing request pending. "
                       "Session start will resume automatic pairing; use a2a_connector_pair for approval details. "
                       "stderr: %s", _log_path(state))
    else:
        logger.warning("A2A Connector self-check: configuration present; not yet paired. "
                       "Session start will request pairing automatically; use a2a_connector_pair for approval details. "
                       "Missing pairing state does not block startup. stderr: %s", _log_path(state))


def _start():
    args = _args()
    _, _, _, _, state = _settings()
    pid_path = state.with_suffix(".pid")
    if pid_path.exists():
        try:
            os.kill(_pid(pid_path), 0)
            return "A2A Connector process is already running; use a2a_connector_pair to check pairing"
        except (ProcessLookupError, ValueError):
            pass
    # Do this before spawning: first-run pairing may not have created the directory yet.
    state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path = _log_path(state)
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "ab") as stderr:
        os.fchmod(stderr.fileno(), 0o600)
        process = subprocess.Popen(args + ["-auto-pair"], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=stderr,
                                   start_new_session=True)
    try:
        try:
            code = process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            pass
        else:
            raise subprocess.SubprocessError(
                f"Connector exited during startup (status {code}); inspect private stderr log: {log_path}")
        fd = os.open(pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(str(process.pid))
    except (OSError, subprocess.SubprocessError):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        pid_path.unlink(missing_ok=True)
        raise
    return f"A2A Connector process started; pairing/connectivity not yet verified. stderr: {log_path}"


def _stop():
    _, _, _, _, state = _settings()
    pid_path = state.with_suffix(".pid")
    if pid_path.exists():
        try:
            os.kill(_pid(pid_path), signal.SIGTERM)
        except (ProcessLookupError, ValueError):
            pass
        pid_path.unlink(missing_ok=True)


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
            _stop()
            return "A2A Connector stopped"
        return "Usage: /a2a_connector pair [pair_code] | start | stop"
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return f"A2A Connector error: {error}"


def register(ctx):
    _self_check_once()
    schema = {"name": "a2a_connector_pair",
              "description": "Show the pending pairing approval link and confirmation code. Optionally redeem a manual pair_ code.",
              "parameters": {"type": "object", "properties": {"code": {"type": "string"}}}}
    ctx.register_tool(name="a2a_connector_pair", toolset="a2a_connector",
                      schema=schema, handler=_tool)
    ctx.register_command("a2a_connector", handler=_command,
                         description="Pair, start, or stop the outbound A2A Connector")
    def on_session_start(**kwargs):
        try:
            logging.getLogger(__name__).info("%s", _start())
        except ValueError as error:
            logging.getLogger(__name__).error(
                "A2A Connector not started: %s. Set the missing values in the active Gateway/profile "
                "environment (normally its .env), then restart the Gateway.", error)
        except OSError as error:
            logging.getLogger(__name__).error(
                "A2A Connector launch or state-file operation failed: %s. Check A2A_NODE_BINARY, "
                "the bundled CLI and permissions on the Connector state directory.", error)
        except subprocess.SubprocessError as error:
            logging.getLogger(__name__).error("A2A Connector startup failed: %s", error)
    ctx.register_hook("on_session_start", on_session_start)
