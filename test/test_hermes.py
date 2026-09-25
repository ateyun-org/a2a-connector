import importlib.util
import os
from pathlib import Path
import signal
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
        with patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import sys; sys.stderr.write('diagnostic\\n'); sys.exit(7)"]):
            with self.assertRaisesRegex(subprocess.SubprocessError, "status 7"):
                plugin._start()
        log = plugin._log_path(self.state)
        self.assertIn("diagnostic", log.read_text())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.state.with_suffix(".pid").exists())

    def test_first_start_creates_private_directory_and_pid_without_pairing_state(self):
        process = None
        original = subprocess.Popen
        def spawn(*args, **kwargs):
            nonlocal process
            process = original(*args, **kwargs)
            return process
        try:
            with patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]), patch.object(plugin.subprocess, "Popen", side_effect=spawn):
                result = plugin._start()
            self.assertIn("not yet verified", result)
            self.assertFalse(self.state.exists())
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
            if Path(path) == self.state.with_suffix(".pid"):
                raise PermissionError("PID path denied")
            return real_open(path, *args)
        process = None
        original = subprocess.Popen
        def spawn(*args, **kwargs):
            nonlocal process
            process = original(*args, **kwargs)
            return process
        with patch.object(plugin, "_args", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]), patch.object(plugin.subprocess, "Popen", side_effect=spawn), patch.object(plugin.os, "open", side_effect=open_file):
            with self.assertRaises(PermissionError):
                plugin._start()
        self.assertIsNotNone(process.poll())

    def test_hook_reports_spawn_and_early_exit_failures_as_errors(self):
        ctx = Context()
        with patch.object(plugin, "_self_check_once"):
            plugin.register(ctx)
        for error, expected in [(OSError("spawn denied"), "launch or state-file"),
                                (subprocess.SubprocessError("status 7"), "startup failed")]:
            with patch.object(plugin, "_start", side_effect=error), self.assertLogs(plugin.__name__, level="ERROR") as logs:
                ctx.hook()
            self.assertIn(expected, " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
