import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


support = module("hermes_a2a_support", ROOT / "plugins/hermes/a2a_support.py")
installer = module("hermes_a2a_installer", ROOT / "scripts/install-hermes.py")
plugin = module("hermes_a2a_plugin", ROOT / "plugins/hermes/__init__.py")


class HermesA2ATests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "host"
        self.root.mkdir()
        self.home = Path(self.tmp.name) / "profile"
        self.env = {"HERMES_HOME": str(self.home)}

    def native(self, legacy=False):
        file = self.root / ("gateway/platforms/a2a.py" if legacy else "plugins/platforms/a2a/__init__.py")
        file.parent.mkdir(parents=True)
        file.write_text("# Installed native capability, even if disabled")

    def test_current_and_legacy_native_paths_are_detected_even_when_disabled(self):
        for legacy in (False, True):
            self.native(legacy)
            calls = []
            with patch.object(support, "native_port", return_value=12345):
                selected = support.select_a2a(self.env, self.root,
                    lambda origin, token: calls.append((origin, token)))
            self.assertEqual(selected, {"mode": "native", "local": "http://127.0.0.1:12345"})
            self.assertEqual(calls, [("http://127.0.0.1:12345", "")])

    def test_absence_uses_compatibility_without_guessing_another_agents_port(self):
        selected = support.select_a2a(self.env, self.root,
            lambda *_: self.fail("An arbitrary port must not select another Agent"))
        self.assertEqual(selected, {"mode": "compat"})
        with patch.object(support.importlib.util, "find_spec", return_value=None):
            with self.assertRaisesRegex(ValueError, "Python interpreter"):
                support.select_a2a(self.env)

    def test_disabled_unreachable_and_broken_native_services_never_fall_back(self):
        self.native()
        for failure in [urllib.error.URLError(ConnectionRefusedError()),
                        urllib.error.HTTPError("http://localhost", 401, "unauthorized", {}, None),
                        urllib.error.HTTPError("http://localhost", 404, "disabled", {}, None),
                        ValueError("invalid card")]:
            with patch.object(support, "native_port", return_value=9900):
                with self.assertRaisesRegex(ValueError, "Compatibility A2A was not selected"):
                    support.select_a2a(self.env, self.root, lambda *_: (_ for _ in ()).throw(failure))

    def test_native_probe_uses_advertised_path_and_tenant_but_keeps_credentials_local(self):
        calls = []
        token = "PRIVATE_LOCAL_TOKEN"
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                self.send_response(200); self.end_headers()
                self.wfile.write(json.dumps({"name": "Hermes", "supportedInterfaces": [{
                    "protocolBinding": "JSONRPC", "url": "https://public.example/rpc", "tenant": "reviewer"}]}).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, self.headers.get("Authorization"), body))
                self.send_response(200); self.end_headers()
                code = -32001 if self.headers.get("Authorization") == "Bearer " + token else -32050
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": body["id"], "error": {"code": code}}).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        origin = f"http://127.0.0.1:{server.server_port}"
        support.probe(origin, token)
        self.assertEqual(calls[0][0:2], ("/rpc", "Bearer " + token))
        self.assertEqual(calls[0][2]["params"]["tenant"], "reviewer")
        with self.assertRaisesRegex(ValueError, "authentication"):
            support.probe(origin, "wrong")

    def test_explicit_origin_is_validated_and_does_not_need_source_inspection(self):
        env = {"A2A_LOCAL_URL": "http://127.0.0.1:12345", "A2A_LOCAL_TOKEN": "private"}
        with patch.object(support, "hermes_root", side_effect=AssertionError("must not inspect")):
            result = support.select_a2a(env, request_probe=lambda origin, token: self.assertEqual(token, "private"))
        self.assertEqual(result["mode"], "existing")
        for origin in ["http://user:secret@localhost", "http://localhost/rpc", "http://localhost?query"]:
            with self.assertRaises(ValueError):
                support.select_a2a({"A2A_LOCAL_URL": origin})

    def test_installer_copies_compatibility_only_when_absent_and_preserves_config(self):
        for mode in ("native", "compat"):
            home = self.home / mode
            home.mkdir(parents=True)
            config = home / "config.yaml"; config.write_text("existing: settings\n")
            selected = {"mode": mode, "local": "http://127.0.0.1:9900"}
            def detect(args, **kwargs):
                self.assertEqual(args[0], "/actual/hermes/python")
                self.assertEqual(kwargs["env"]["HERMES_HOME"], str(home.resolve()))
                return subprocess.CompletedProcess(args, 0, stdout=json.dumps(selected))
            self.assertEqual(installer.install_hermes(home, "/actual/hermes/python", env={}, run=detect), selected)
            installed = home / "plugins/a2a-connector"
            self.assertEqual((installed / "adapter-server.js").exists(), mode == "compat")
            self.assertEqual((installed / "agent-driver.js").exists(), mode == "compat")
            self.assertTrue((installed / "vendor/connector/state-lock.js").exists())
            self.assertTrue((installed / "vendor/connector/node_modules/ws/package.json").exists())
            self.assertTrue((installed / "runner.js").exists())
            self.assertEqual(json.loads((installed / "package.json").read_text())["type"], "module")
            self.assertEqual(config.read_text(), "existing: settings\n")
            with self.assertRaisesRegex(ValueError, "already exists"):
                installer.install_hermes(home, run=detect, python="/actual/hermes/python", env={})

    def test_failed_or_unknown_detection_does_not_install(self):
        for detect in [lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="{}"),
                       lambda *a, **k: (_ for _ in ()).throw(subprocess.CalledProcessError(1, a, stderr="unreachable"))]:
            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                installer.install_hermes(self.home, env={}, run=detect)
            self.assertFalse(self.home.exists())

    def test_child_sessions_do_not_register_startup_hooks_or_start_another_connector(self):
        with patch.dict(plugin.os.environ, {"A2A_CONNECTOR_CHILD": "1"}, clear=True), patch.object(plugin, "_self_check_once") as check:
            plugin.register(object())
            check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
