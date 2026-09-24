"""Hermes A2A Connector plugin."""

import json
import logging
import os
from pathlib import Path
import signal
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
    if not relay or not local:
        raise ValueError("Set A2A_RELAY_URL and A2A_LOCAL_URL before pairing")
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


def _start():
    _, _, _, _, state = _settings()
    pid_path = state.with_suffix(".pid")
    if pid_path.exists():
        try:
            os.kill(int(pid_path.read_text()), 0)
            return
        except (ProcessLookupError, ValueError):
            pass
    process = subprocess.Popen(_args() + ["-auto-pair"], stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    pid_path.write_text(str(process.pid))
    pid_path.chmod(0o600)


def _stop():
    _, _, _, _, state = _settings()
    pid_path = state.with_suffix(".pid")
    if pid_path.exists():
        try:
            os.kill(int(pid_path.read_text()), signal.SIGTERM)
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
            _start()
            return "A2A Connector started"
        if parts == ["stop"]:
            _stop()
            return "A2A Connector stopped"
        return "Usage: /a2a_connector pair [pair_code] | start | stop"
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return f"A2A Connector error: {error}"


def register(ctx):
    schema = {"name": "a2a_connector_pair",
              "description": "Show the pending pairing approval link and confirmation code. Optionally redeem a manual pair_ code.",
              "parameters": {"type": "object", "properties": {"code": {"type": "string"}}}}
    ctx.register_tool(name="a2a_connector_pair", toolset="a2a_connector",
                      schema=schema, handler=_tool)
    ctx.register_command("a2a_connector", handler=_command,
                         description="Pair, start, or stop the outbound A2A Connector")
    def on_session_start(**kwargs):
        try:
            _start()
        except (OSError, ValueError) as error:
            logging.getLogger(__name__).warning("A2A Connector start failed: %s", error)
    ctx.register_hook("on_session_start", on_session_start)
