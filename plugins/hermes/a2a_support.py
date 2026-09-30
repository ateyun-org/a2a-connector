"""Inspect the active Hermes installation and validate its local A2A service."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def local_origin(value):
    url = urllib.parse.urlsplit(value)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("A2A_LOCAL_URL must be auto or an HTTP(S) origin")
    return urllib.parse.urlunsplit((url.scheme, url.netloc, "", "", ""))


def local_token(env):
    if env.get("A2A_LOCAL_TOKEN"):
        return env["A2A_LOCAL_TOKEN"]
    if env.get("A2A_BEARER_TOKEN"):
        return env["A2A_BEARER_TOKEN"]
    for item in env.get("A2A_PEER_TOKENS", "").split(","):
        peer, sep, token = item.partition(":")
        if sep and peer.strip() == "connector":
            return token.strip()
    return ""


def hermes_root():
    spec = importlib.util.find_spec("hermes_cli")
    if not spec or not spec.origin:
        raise ValueError("Cannot inspect this Hermes installation; run with its Python interpreter (--hermes-python)")
    root = Path(spec.origin).resolve().parent.parent
    if not (root / "run_agent.py").is_file():
        raise ValueError("Hermes installation root is incomplete; cannot determine A2A capabilities")
    return root


def has_native_a2a(root, home, env):
    bundled = Path(env.get("HERMES_BUNDLED_PLUGINS") or str(root / "plugins"))
    candidates = [bundled / "platforms/a2a/__init__.py", bundled / "a2a/__init__.py",
                  root / "gateway/platforms/a2a.py", root / "gateway/platforms/a2a/__init__.py",
                  home / "plugins/platforms/a2a/__init__.py"]
    if env.get("HERMES_ENABLE_PROJECT_PLUGINS", "").lower() in ("1", "true", "yes"):
        candidates.append(Path.cwd() / ".hermes/plugins/platforms/a2a/__init__.py")
    return any(path.is_file() for path in candidates)


def native_port(env):
    # load_config uses the selected Hermes home/profile, including extra.port.
    from hermes_cli.config import load_config
    config = load_config()
    port = env.get("A2A_PORT") or (config.get("gateway", {}).get("platforms", {})
                                  .get("a2a", {}).get("extra", {}).get("port", 9900))
    port = int(port)
    if not 1 <= port <= 65535:
        raise ValueError("Invalid native A2A port")
    return port


def request_json(url, token, body=None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=payload, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=5) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Local A2A response is too large")
        return json.loads(raw)


def probe(origin, token):
    card = request_json(origin + "/.well-known/agent-card.json", token)
    if not isinstance(card, dict) or not isinstance(card.get("name"), str) or not card["name"].strip():
        raise ValueError("Invalid local A2A Agent Card")
    interfaces = card.get("supportedInterfaces", [])
    interface = next((item for item in interfaces if isinstance(item, dict)
                      and item.get("protocolBinding") == "JSONRPC"), None)
    if not interface:
        raise ValueError("Local A2A Agent Card has no JSON-RPC interface")
    advertised = urllib.parse.urlsplit(interface.get("url", ""))
    if advertised.scheme not in ("http", "https") or not advertised.hostname or advertised.query or advertised.fragment:
        raise ValueError("Invalid A2A interface URL")
    # The public origin can differ behind a proxy. Keep credentials on the configured local origin.
    params = {"id": "__a2a_connector_auth_probe__"}
    if interface.get("tenant"):
        params["tenant"] = interface["tenant"]
    result = request_json(origin + (advertised.path or "/"), token,
                          {"jsonrpc": "2.0", "id": "connector-auth-probe", "method": "GetTask", "params": params})
    if (not isinstance(result, dict) or result.get("jsonrpc") != "2.0"
            or result.get("id") != "connector-auth-probe" or result.get("error", {}).get("code") != -32001):
        raise ValueError("A2A task endpoint failed authentication or the read-only GetTask probe")


def select_a2a(env=None, root=None, request_probe=None):
    env = os.environ if env is None else env
    request_probe = probe if request_probe is None else request_probe
    explicit = env.get("A2A_LOCAL_URL", "auto").strip() or "auto"
    token = local_token(env)
    if explicit != "auto":
        origin = local_origin(explicit)
        request_probe(origin, token)
        return {"mode": "existing", "local": origin}
    root = hermes_root() if root is None else Path(root)
    home = Path(env.get("HERMES_HOME", "~/.hermes")).expanduser()
    native = has_native_a2a(root, home, env)
    if not native:
        # An arbitrary listener on 9900 may belong to another Agent. Existing external
        # services must be selected explicitly; source inspection proves native absence.
        return {"mode": "compat"}
    port = native_port(env)
    origin = f"http://127.0.0.1:{port}"
    try:
        request_probe(origin, token)
        return {"mode": "native", "local": origin}
    except (urllib.error.URLError, ValueError) as error:
        raise ValueError("Hermes A2A is installed; enable/fix the native platform, token and Gateway. Compatibility A2A was not selected.") from error


if __name__ == "__main__":
    try:
        print(json.dumps(select_a2a()))
    except Exception as error:
        # Avoid dumping credential-bearing HTTP bodies or subprocess environment.
        print(f"Hermes A2A detection failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
