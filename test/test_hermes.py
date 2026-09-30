import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hermes_connector", Path(__file__).resolve().parents[1] / "plugins/hermes/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Context:
    def register_tool(self, **kwargs):
        pass

    def register_command(self, *args, **kwargs):
        pass

    def register_hook(self, name, handler):
        self.hook = handler


class HermesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "private/hermes.json"
        self.host_env = dict(os.environ)
        self.env = patch.dict(os.environ, {
            "A2A_RELAY_URL": "wss://relay.example/connect",
            "A2A_LOCAL_URL": "http://127.0.0.1:9900",
            "A2A_NODE_BINARY": sys.executable,
            "A2A_CONNECTOR_STATE": str(self.state),
        }, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_missing_environment_is_an_error_at_registration_and_hook(self):
        del os.environ["A2A_RELAY_URL"]
        ctx = Context()
        with patch.object(plugin.subprocess, "Popen") as spawn, self.assertLogs(plugin.__name__, level="ERROR") as logs:
            plugin.register(ctx)
            ctx.hook()
        spawn.assert_not_called()
        self.assertIn("A2A_RELAY_URL", " ".join(logs.output))
        self.assertIn("restart the Gateway", " ".join(logs.output))

    def test_unpaired_self_check_does_not_spawn_or_block_hook(self):
        ctx = Context()
        with patch.object(plugin, "_start", return_value="started") as start, self.assertLogs(plugin.__name__, level="WARNING") as logs:
            plugin.register(ctx)
            start.assert_not_called()
            ctx.hook()
        start.assert_called_once()
        self.assertIn("not yet paired", " ".join(logs.output))
        self.assertIn("does not block startup", " ".join(logs.output))

    def test_pending_and_existing_state_are_distinguished_without_reading_tokens(self):
        self.state.parent.mkdir()
        pending = Path(str(self.state) + ".pending")
        pending.write_text('SECRET_PENDING_TOKEN')
        with self.assertLogs(plugin.__name__, level="WARNING") as logs:
            plugin._self_check_once()
        self.assertIn("request pending", " ".join(logs.output))
        self.assertNotIn("SECRET", " ".join(logs.output))
        self.state.write_text('SECRET_CREDENTIAL')
        with self.assertLogs(plugin.__name__, level="INFO") as logs:
            plugin._self_check_once()
        self.assertIn("not validated", " ".join(logs.output))
        self.assertNotIn("SECRET", " ".join(logs.output))

    def test_missing_binary_is_reported(self):
        os.environ["A2A_NODE_BINARY"] = "/missing/node"
        with self.assertLogs(plugin.__name__, level="ERROR") as logs:
            plugin._self_check_once()
        self.assertIn("Node executable not found", " ".join(logs.output))

    def test_immediate_child_failure_preserves_stderr_and_removes_pid(self):
        with patch.object(plugin, "_status", return_value={"running": False}), patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import sys; sys.stderr.write('diagnostic\\n'); sys.exit(7)"]):
            with self.assertRaisesRegex(subprocess.SubprocessError, "status 7"):
                plugin._start()
        log = plugin._log_path(self.state)
        self.assertIn("diagnostic", log.read_text())
        if os.name != "nt":
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.state.with_suffix(".pid").exists())

    def test_first_start_creates_private_directory_and_pid_without_pairing_state(self):
        process = None
        original = subprocess.Popen
        def spawn(*args, **kwargs):
            nonlocal process
            process = original(*args, **kwargs)
            return process
        def status():
            return {"running": bool(process and process.poll() is None), "pid": process.pid if process else None}
        try:
            with patch.object(plugin, "_status", side_effect=status), patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]), patch.object(plugin.subprocess, "Popen", side_effect=spawn):
                result = plugin._start()
            self.assertIn("not yet verified", result)
            self.assertFalse(self.state.exists())
            if os.name != "nt":
                self.assertEqual(self.state.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(self.state.with_suffix(".pid").stat().st_mode & 0o777, 0o600)
        finally:
            if process:
                process.terminate()
                process.wait(timeout=5)

    def test_pid_write_failure_terminates_spawned_child(self):
        self.state.parent.mkdir()
        real_open = os.open
        def open_file(path, *args):
            if Path(path).resolve() == self.state.with_suffix(".pid").resolve():
                raise PermissionError("PID path denied")
            return real_open(path, *args)
        process = None
        original = subprocess.Popen
        def spawn(*args, **kwargs):
            nonlocal process
            process = original(*args, **kwargs)
            return process
        def stop():
            process.terminate()
            process.wait(timeout=5)
        def status():
            return {"running": bool(process and process.poll() is None), "pid": process.pid if process else None}
        with patch.object(plugin, "_status", side_effect=status), patch.object(plugin, "_stop", side_effect=stop) as cleanup, patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]), patch.object(plugin.subprocess, "Popen", side_effect=spawn), patch.object(plugin.os, "open", side_effect=open_file):
            with self.assertRaises(PermissionError):
                plugin._start()
        self.assertIsNotNone(process.poll())
        cleanup.assert_called_once()

    def test_hook_reports_spawn_and_early_exit_failures_as_errors(self):
        ctx = Context()
        with patch.object(plugin, "_self_check_once"):
            plugin.register(ctx)
        for error, expected in [(OSError("spawn denied"), "startup failed"),
                                (subprocess.SubprocessError("status 7"), "startup failed")]:
            with patch.object(plugin, "_start", side_effect=error), self.assertLogs(plugin.__name__, level="ERROR") as logs:
                ctx.hook()
            self.assertIn(expected, " ".join(logs.output))

    def test_status_reuses_manual_runner_without_python_kill_or_duplicate_spawn(self):
        with patch.object(plugin, "_status", return_value={"running": True, "pid": 1234}), patch.object(plugin.os, "kill", side_effect=AssertionError("Must never use Python os.kill")), patch.object(plugin.subprocess, "Popen") as spawn:
            self.assertIn("already running", plugin._start())
            spawn.assert_not_called()

    def test_pairing_never_requests_approval_before_background_start_succeeds(self):
        with patch.object(plugin, "_start", side_effect=OSError("invalid Node path")), patch.object(plugin, "_status") as status:
            self.assertIn("invalid Node path", plugin._tool({}))
            status.assert_not_called()

    def test_pairing_does_not_claim_connected_from_a_saved_credential(self):
        with patch.object(plugin, "_start"), patch.object(plugin, "_status", return_value={"paired": True, "agentId": "test", "tunnelOnline": False}):
            self.assertFalse(json.loads(plugin._pair())["connected"])

    def test_runtime_python_is_the_host_interpreter_even_with_wrong_environment(self):
        os.environ["A2A_HERMES_PYTHON"] = "/wrong/python3"
        self.assertEqual(plugin._runtime_env()["A2A_HERMES_PYTHON"], sys.executable)

    def test_dedicated_settings_are_reread_without_gateway_restart(self):
        root = Path(self.tmp.name)
        config = root / "connector-config.json"
        with patch.object(plugin, "_ROOT", root):
            config.write_text(json.dumps({"A2A_NODE_BINARY": "D:/Program Files/nodejs/node.exe"}))
            self.assertEqual(plugin._settings()[0], "D:/Program Files/nodejs/node.exe")
            config.write_text(json.dumps({"A2A_NODE_BINARY": sys.executable}))
            self.assertEqual(plugin._settings()[0], sys.executable)
            config.write_text(json.dumps({"A2A_LOCAL_TOKEN": "not-allowed"}))
            with self.assertRaisesRegex(ValueError, "non-secret"):
                plugin._settings()

    def test_private_file_permissions_do_not_require_fchmod(self):
        with patch.object(plugin.os, "fchmod", None, create=True):
            fd = plugin._host.private_open(self.state, os.O_WRONLY | os.O_CREAT)
            os.close(fd)
        self.assertTrue(self.state.exists())

    @unittest.skipUnless(os.name == "nt", "Native Windows DACL validation")
    def test_windows_directory_has_protected_user_and_system_acl(self):
        plugin._host.private_directory(self.state.parent)
        # PowerShell reads Windows ACLs; POSIX mode bits do not establish privacy.
        script = "$a=Get-Acl -LiteralPath $env:A2A_TEST_ACL; $a.AreAccessRulesProtected; $a.Access.Count"
        powershell = shutil.which("powershell", path=self.host_env.get("PATH"))
        result = subprocess.run([powershell, "-NoProfile", "-Command", script],
                                env=dict(self.host_env, A2A_TEST_ACL=str(self.state.parent)),
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.split(), ["True", "2"])


if __name__ == "__main__":
    unittest.main()
