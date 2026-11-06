"""Regression coverage for the native Hermes synchronous-reply repair."""

import importlib.util
import contextvars
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hermes_native_async_repair", ROOT / "scripts/patch-hermes-a2a-async.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)

# A small native-handler contract fixture. The blocking method and pending-lock
# contract follow NousResearch/hermes-agent/plugins/platforms/a2a/adapter.py.
NATIVE = '''\
import threading
import time
import contextvars
from collections import deque
from concurrent.futures import Future, TimeoutError
from types import SimpleNamespace

def build_task(task_id, context_id, state, reply="", *, created_at=""):
    return {"id": task_id, "contextId": context_id, "status": {"state": state, "message": reply}}

protocol = SimpleNamespace(STATE_WORKING="working", STATE_FAILED="failed", build_task=build_task,
                           send_message_response=lambda task: {"task": task})
def _ok(req_id, result):
    return {"id": req_id, "result": result}
PROFILE = contextvars.ContextVar("native-reference-profile", default="unscoped")

class Store:
    def __init__(self):
        self.rows = {}
        self.now = 0
    def fail_orphans(self, timeout, *, exclude):
        expired = [task_id for task_id, task in self.rows.items()
                   if task["status"]["state"] == "working" and task_id not in exclude and self.now > timeout]
        for task_id in expired:
            self.rows[task_id]["status"]["state"] = "failed"
        return expired

class A2AAdapter:
    def __init__(self):
        self._pending_lock = threading.Lock()
        self._active_tasks = set()
        self._pending = {}
        self._pending_order = {}
        self.tasks = Store()
        self.accepted = 0
        self.finalized = 0
        self.finalized_scopes = []
        self.profile = PROFILE
    def _add_pending(self, task_id, context_id):
        fut = Future()
        with self._pending_lock:
            self._active_tasks.add(task_id)
            self._pending[task_id] = (context_id, fut)
            self._pending_order.setdefault(context_id, deque()).append(task_id)
        return fut
    def _fail_orphans_once(self):
        with self._pending_lock:
            active_tasks = set(self._active_tasks)
        return self.tasks.fail_orphans(300, exclude=active_tasks)
    def _prepare_task(self, params, peer, agent=None):
        self.accepted += 1
        task_id = "task-" + str(self.accepted)
        if params.get("reject"):
            return build_task(task_id, "ctx", "rejected"), None
        future = self._add_pending(task_id, "ctx")
        self.tasks.rows[task_id] = build_task(task_id, "ctx", "working")
        return None, {"task_id": task_id, "context_id": "ctx", "created_iso": "now", "future": future}
    def _await_reply(self, pending):
        try:
            return pending["future"].result(timeout=0.02)
        except TimeoutError:
            return "failed", "[agent did not reply in time]"
    def _finalize_task(self, pending, state, reply):
        with self._pending_lock:
            task_id = pending["task_id"]
            self.finalized += 1
            self.finalized_scopes.append(PROFILE.get())
            self.tasks.rows[task_id] = build_task(task_id, "ctx", state, reply)
            self._pending.pop(task_id, None)
            self._active_tasks.discard(task_id)
        return state, reply
    def _rpc_message_send(self, req_id, params, peer, agent=None, v1_response=False):
        task, pending = self._prepare_task(params, peer, agent=agent)
        if task is None:
            state, reply = self._finalize_task(pending, *self._await_reply(pending))
            task = protocol.build_task(pending["task_id"], pending["context_id"], state, reply, created_at=pending["created_iso"])
        return _ok(req_id, protocol.send_message_response(task) if v1_response else task)
    def reply_under_native_lock(self, task_id, state, reply):
        with self._pending_lock:
            self._pending[task_id][1].set_result((state, reply))
    def get_task(self, task_id):
        return self.tasks.rows[task_id]

# This code outside the handler must remain byte-for-byte intact.
TAIL_MARKER = "preserved"
'''


class NativeAsyncRepairTests(unittest.TestCase):
    def setUp(self):
        agent = types.ModuleType("agent")
        agent.__path__ = []
        provider = types.ModuleType("agent.memory_provider")
        def spawn_context_thread(target, *, name, daemon=True):
            context = contextvars.copy_context()
            return threading.Thread(target=lambda: context.run(target), name=name, daemon=daemon)
        provider.spawn_context_thread = spawn_context_thread
        modules = patch.dict(sys.modules, {"agent": agent, "agent.memory_provider": provider})
        modules.start()
        self.addCleanup(modules.stop)

    def adapter(self):
        source, _ = repair.patched_source(NATIVE)
        namespace = {}
        exec(compile(source, "<native-contract-fixture>", "exec"), namespace)
        return namespace["A2AAdapter"]()

    def wait_state(self, adapter, task_id, state):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            task = adapter.get_task(task_id)
            if task["status"]["state"] == state:
                return task
            time.sleep(0.005)
        self.fail(f"task did not reach {state}: {adapter.get_task(task_id)}")

    def test_immediate_receipt_survives_reply_window_and_original_task_gets_late_result(self):
        adapter = self.adapter()
        response = adapter._rpc_message_send(1, {"configuration": {"returnImmediately": True}}, "connector", v1_response=True)
        task = response["result"]["task"]
        self.assertEqual(task["status"]["state"], "working")
        self.assertIn(task["id"], adapter._pending)
        adapter.tasks.now = 301
        self.assertEqual(adapter._fail_orphans_once(), [])
        time.sleep(0.03)  # Beyond the fixture's old synchronous reply window.
        self.assertEqual(adapter.get_task(task["id"])["status"]["state"], "working")
        adapter.reply_under_native_lock(task["id"], "completed", "verified result")
        result = self.wait_state(adapter, task["id"], "completed")
        self.assertEqual(result["status"]["message"], "verified result")
        self.assertEqual(result["contextId"], task["contextId"])
        self.assertEqual(adapter.accepted, 1)
        self.assertEqual(adapter.finalized, 1)
        self.assertNotIn(task["id"], adapter._active_tasks)

    def test_completion_callback_does_not_reenter_the_native_pending_lock(self):
        adapter = self.adapter()
        task = adapter._rpc_message_send(1, {"configuration": {"returnImmediately": True}}, "connector")["result"]
        sender = threading.Thread(target=adapter.reply_under_native_lock, args=(task["id"], "completed", "done"), daemon=True)
        sender.start()
        sender.join(timeout=1)
        self.assertFalse(sender.is_alive(), "future callback deadlocked the Gateway sender")
        self.wait_state(adapter, task["id"], "completed")

    def test_finalizer_uses_completion_profile_even_when_future_was_already_done(self):
        for immediate in (False, True):
            adapter = self.adapter()
            original = adapter._prepare_task
            def finish_in_profile(task_id):
                token = adapter.profile.set("routed-profile")
                try:
                    adapter.reply_under_native_lock(task_id, "completed", "scoped result")
                finally:
                    adapter.profile.reset(token)
            if immediate:
                def prepare(*args, **kwargs):
                    task, pending = original(*args, **kwargs)
                    finish_in_profile(pending["task_id"])
                    return task, pending
                adapter._prepare_task = prepare
            task = adapter._rpc_message_send(1, {"configuration": {"returnImmediately": True}}, "connector")["result"]
            if not immediate:
                finish_in_profile(task["id"])
            self.wait_state(adapter, task["id"], "completed")
            self.assertEqual(adapter.finalized_scopes, ["routed-profile"])
            self.assertEqual(adapter.profile.get(), "unscoped")

    def test_receipt_does_not_wait_for_a_racing_scope_capture_callback(self):
        adapter = self.adapter()
        original = adapter._prepare_task
        entered, release = threading.Event(), threading.Event()
        workers = []
        def prepare(*args, **kwargs):
            task, pending = original(*args, **kwargs)
            future = pending["future"]
            capture = future._done_callbacks[0]
            def delayed_capture(completed):
                entered.set()
                release.wait(timeout=2)
                capture(completed)
            future._done_callbacks[0] = delayed_capture
            def complete():
                token = adapter.profile.set("racing-profile")
                try:
                    adapter.reply_under_native_lock(pending["task_id"], "completed", "racing result")
                finally:
                    adapter.profile.reset(token)
            worker = threading.Thread(target=complete, daemon=True)
            workers.append(worker)
            worker.start()
            self.assertTrue(entered.wait(timeout=1))
            return task, pending
        adapter._prepare_task = prepare
        try:
            task = adapter._rpc_message_send(1, {"configuration": {"returnImmediately": True}}, "connector")["result"]
            self.assertEqual(task["status"]["state"], "working")
        finally:
            release.set()
        self.wait_state(adapter, task["id"], "completed")
        workers[0].join(timeout=1)
        self.assertFalse(workers[0].is_alive())
        self.assertEqual(adapter.finalized_scopes, ["racing-profile"])

    def test_legacy_sync_requests_and_immediate_rejections_keep_existing_behavior(self):
        adapter = self.adapter()
        for configuration in (None, {"returnImmediately": False}, {"returnImmediately": "true"}):
            params = {"configuration": configuration} if configuration else {}
            task = adapter._rpc_message_send(1, params, "connector")["result"]
            self.assertEqual(task["status"]["state"], "failed")
            self.assertEqual(task["status"]["message"], "[agent did not reply in time]")
        rejected = adapter._rpc_message_send(2, {"reject": True, "configuration": {"returnImmediately": True}}, "connector")["result"]
        self.assertEqual(rejected["status"]["state"], "rejected")
        self.assertEqual(adapter.finalized, 3)

    def test_failure_and_shutdown_settle_the_same_task_once(self):
        for failed_future in (False, True):
            adapter = self.adapter()
            task = adapter._rpc_message_send(1, {"configuration": {"returnImmediately": True}}, "connector")["result"]
            if failed_future:
                adapter._pending[task["id"]][1].set_exception(RuntimeError("PRIVATE_TOOL_DETAILS"))
            else:
                adapter.reply_under_native_lock(task["id"], "failed", "[agent shutting down]")
            result = self.wait_state(adapter, task["id"], "failed")
            self.assertNotIn("PRIVATE_TOOL_DETAILS", str(result))
            self.assertEqual(adapter.finalized, 1)
            self.assertEqual(adapter.accepted, 1)

    def test_check_apply_and_repeated_apply_preserve_backup_and_unrelated_code(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "plugins/platforms/a2a/adapter.py"
            path.parent.mkdir(parents=True)
            path.write_text(NATIVE)
            path.chmod(0o640)
            helper = root / "agent/memory_provider.py"
            helper.parent.mkdir()
            helper.write_text("def spawn_context_thread(target, *, name, daemon=True):\n    pass\n")
            self.assertEqual(repair.repair(root)["status"], "patchable")
            self.assertEqual(path.read_text(), NATIVE)
            self.assertEqual(list(path.parent.glob("*.before-a2a-async-*")), [])
            result = repair.repair(root, apply=True)
            self.assertEqual(result["status"], "patched")
            self.assertEqual(Path(result["backup"]).read_text(), NATIVE)
            patched = path.read_text()
            self.assertTrue(patched.endswith(NATIVE[NATIVE.index("    def reply_under_native_lock"):]))
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(repair.repair(root, apply=True)["status"], "already_patched")
            self.assertEqual(path.read_text(), patched)
            self.assertEqual(len(list(path.parent.glob("*.before-a2a-async-*"))), 1)

    def test_unknown_native_code_and_missing_orphan_protection_are_rejected(self):
        repaired, _ = repair.patched_source(NATIVE)
        for source in (NATIVE.replace("*self._await_reply(pending)", "*self.custom_wait(pending)"),
                       NATIVE.replace("exclude=active_tasks", "ignored=active_tasks"),
                       NATIVE.replace("self._active_tasks.add(task_id)", "pass"),
                       NATIVE.replace("exclude=active_tasks", "exclude=set()"),
                       repaired.replace("exclude=active_tasks", "exclude=set()")):
            with self.assertRaises(ValueError):
                repair.patched_source(source)

    def test_native_local_future_annotation_does_not_change_compatibility(self):
        source = NATIVE.replace("fut = Future()", "fut: Future = Future()")
        patched, status = repair.patched_source(source)
        self.assertEqual(status, "patchable")
        self.assertEqual(repair.patched_source(patched)[1], "already_patched")


if __name__ == "__main__":
    unittest.main()
