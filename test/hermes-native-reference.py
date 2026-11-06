#!/usr/bin/env python3
"""Exercise the repair against an external official Hermes A2A source checkout.

The real adapter, protocol store and security modules run on an isolated
loopback server. Only the Gateway/model runtime is replaced with a controlled
session and profile runtime. No source files in --hermes-root are changed and no model is called.
"""

import argparse
import asyncio
import contextvars
import enum
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_async_repair", ROOT / "scripts/patch-hermes-a2a-async.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def install_runtime_stubs(home):
    for name in ("gateway", "gateway.platforms", "agent", "hermes_cli", "reference_a2a"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    shared = types.ModuleType("gateway.platforms._shared")
    shared.coerce_port = lambda value, default=0: int(value) if str(value).lstrip("-").isdigit() else default
    shared.get_scoped_secret = lambda name, default=None: os.environ.get(name, default)
    shared.profile_scoped = lambda: False
    sys.modules[shared.__name__] = shared
    constants = types.ModuleType("hermes_constants")
    constants.get_hermes_home = lambda: Path(home)
    sys.modules[constants.__name__] = constants
    bypass = types.ModuleType("agent.proxy_bypass")
    def loopback(host):
        if host == "localhost":
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except ValueError:
            return False
    bypass.is_loopback_host = loopback
    sys.modules[bypass.__name__] = bypass
    provider = types.ModuleType("agent.memory_provider")
    def spawn_context_thread(target, *, name, daemon=True):
        context = contextvars.copy_context()
        return threading.Thread(target=lambda: context.run(target), name=name, daemon=daemon)
    provider.spawn_context_thread = spawn_context_thread
    sys.modules[provider.__name__] = provider
    base = types.ModuleType("gateway.platforms.base")
    class BasePlatformAdapter:
        def __init__(self, **kwargs):
            self._message_handler = object()
            self.accepted_events = []
        def build_source(self, **kwargs):
            return types.SimpleNamespace(**kwargs)
        async def handle_message(self, event):
            self.accepted_events.append(event)
            if getattr(self, "reference_auto_reply", False):
                await asyncio.sleep(0.15)
                await self.send(event.source.chat_id, "late DSH native result", metadata={"notify": True})
        def _mark_connected(self):
            pass
        def _mark_disconnected(self):
            pass
        def _wire_plugin_handlers(self, _value):
            pass
    base.BasePlatformAdapter = BasePlatformAdapter
    base.SendResult = types.SimpleNamespace
    sys.modules[base.__name__] = base
    event = types.ModuleType("gateway.platforms.event")
    event.MessageEvent = types.SimpleNamespace
    event.MessageType = types.SimpleNamespace(TEXT="text")
    event.ProcessingOutcome = enum.Enum("ProcessingOutcome", "SUCCESS FAILURE CANCELLED")
    sys.modules[event.__name__] = event
    config = types.ModuleType("gateway.config")
    config.Platform = str
    sys.modules[config.__name__] = config


def load(name, path, source=None):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    if source is None:
        spec.loader.exec_module(module)
    else:
        exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def exercise(native, repaired, with_dsh=False, home=None):
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    adapter = native.A2AAdapter(types.SimpleNamespace(extra={"port": 0}))
    native._reply_timeout = lambda: 0.05
    def run(coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, loop).result(timeout=3)
    def request(method, params, token="connector-reference-secret"):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{adapter._httpd.server_port}/", data=body,
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=2) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)
    def send(index):
        return request("SendMessage", {"message": {"messageId": "reference-" + str(index), "role": "ROLE_USER",
                       "parts": [{"text": "controlled native reference task"}]}, "configuration": {"returnImmediately": True}})
    def wait_task(task_id, state, http=True):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            task = request("GetTask", {"id": task_id})[1]["result"] if http else native.protocol.TaskStore.to_task(adapter.tasks.get(task_id))
            if task["status"]["state"] == state:
                return task
            time.sleep(0.005)
        raise AssertionError(f"native task {task_id} did not reach {state}")
    disconnected = False
    try:
        assert run(adapter.connect())
        status, response = send(1)
        assert status == 200
        task = response["result"]["task"]
        if not repaired:
            assert task["status"]["state"] == "TASK_STATE_FAILED"
            assert "agent did not reply in time" in str(task)
            return {"unpatched": "reproduced native reply timeout"}
        assert task["status"]["state"] == "TASK_STATE_WORKING"
        assert request("GetTask", {"id": task["id"]}, "invalid-reference-token")[0] == 401
        assert request("GetTask", {"id": task["id"]}, "untrusted-reference-secret")[0] == 403
        with adapter.tasks._lock:
            adapter.tasks._tasks[task["id"]]["created_at"] -= 301
        assert adapter._fail_orphans_once() == []
        time.sleep(0.06)
        assert request("GetTask", {"id": task["id"]})[1]["result"]["status"]["state"] == "TASK_STATE_WORKING"
        run(adapter.send(task["contextId"], "late native result", metadata={"notify": True}))
        completed = wait_task(task["id"], "TASK_STATE_COMPLETED")
        assert completed["contextId"] == task["contextId"]
        assert "late native result" in str(completed)
        assert len(adapter.accepted_events) == 1
        status, response = send(2)
        task = response["result"]["task"]
        run(adapter.send(task["contextId"], "[INPUT_REQUIRED] confirm the next step", metadata={"notify": True}))
        question = wait_task(task["id"], "TASK_STATE_INPUT_REQUIRED")
        assert "confirm the next step" in str(question)
        assert "[INPUT_REQUIRED]" not in str(question)
        status, response = send(3)
        canceled_id = response["result"]["task"]["id"]
        assert request("CancelTask", {"id": canceled_id})[1]["result"]["status"]["state"] == "TASK_STATE_CANCELED"
        wait_task(canceled_id, "TASK_STATE_CANCELED")
        if with_dsh:
            adapter.reference_auto_reply = True
            client = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { A2AOrchestrator, stateName, responseParts } = await import(pathToFileURL(process.argv[3]).href);
const client = new A2AOrchestrator({ storePath: process.argv[2], requestTimeoutMs: 2000, taskTimeoutMs: 5000,
  agents: [{ id: 'native-hermes', url: process.argv[1], allowHttp: true, tokenEnv: 'A2A_REFERENCE_TOKEN' }] });
const { conversation } = await client.send({ agentId: 'native-hermes', parentId: 'reference-parent',
  messageId: 'dsh-reference-once', content: [{ type: 'text', text: 'controlled DSH reference task' }] });
assert.equal(stateName(conversation.state), 'working');
const deadline = Date.now() + 3000;
let task;
do {
  task = await client.getTask(conversation.id, 'reference-parent');
  if (stateName(task.status.state) === 'completed') break;
  await new Promise(resolve => setTimeout(resolve, 20));
} while (Date.now() < deadline);
assert.equal(stateName(task.status.state), 'completed');
assert.equal(task.id, conversation.taskId);
assert.equal(task.contextId, conversation.contextId);
assert.match(JSON.stringify(responseParts(task)), /late DSH native result/);
console.log(JSON.stringify({ receipt: 'working', result: 'completed', sameTask: true, sameContext: true }));
'''
            result = subprocess.run(["node", "--input-type=module", "-e", client,
                f"http://127.0.0.1:{adapter._httpd.server_port}", str(Path(home) / "dsh-conversations.json"),
                str(ROOT / "plugins/dsh/orchestrator.js")], capture_output=True, text=True, timeout=8,
                env=dict(os.environ, A2A_REFERENCE_TOKEN="connector-reference-secret"))
            if result.returncode:
                raise AssertionError("DSH native interop failed: " + result.stderr)
            assert json.loads(result.stdout)["sameTask"]
            adapter.reference_auto_reply = False
        status, response = send(4)
        shutdown_id = response["result"]["task"]["id"]
        run(adapter.disconnect())
        disconnected = True
        wait_task(shutdown_id, "TASK_STATE_FAILED", http=False)
        assert len(adapter.accepted_events) == 4 + int(with_dsh)
        return {"patched": "working receipt, late result, input-required, cancellation and shutdown verified",
                "authorization": "401 invalid credential and 403 untrusted peer preserved", "redispatches": 0}
    finally:
        if not disconnected:
            run(adapter.disconnect())
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", required=True)
    parser.add_argument("--with-dsh", action="store_true", help="Also run the actual DSH SDK client; requires its repository dependencies")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Use the actual Hermes Python (3.11+ for the current official adapter)")
    directory = Path(args.hermes_root).expanduser().resolve() / "plugins/platforms/a2a"
    source = (directory / "adapter.py").read_text()
    patched, _ = repair.patched_source(source)
    for name in list(os.environ):
        if name.startswith("A2A_"):
            del os.environ[name]
    os.environ.update(A2A_PEER_TOKENS="connector:connector-reference-secret,untrusted:untrusted-reference-secret",
                      A2A_TRUSTED_PEERS="connector")
    with tempfile.TemporaryDirectory(prefix="hermes-native-reference-home-") as home:
        install_runtime_stubs(home)
        load("hermes_cli.home_data_layout", directory.parents[2] / "hermes_cli/home_data_layout.py")
        load("agent.file_safety", directory.parents[2] / "agent/file_safety.py")
        connection_redaction = directory.parents[2] / "agent/redact_connstr.py"
        if connection_redaction.is_file():  # Older native layouts keep these helpers in redact.py.
            load("agent.redact_connstr", connection_redaction)
        load("agent.redact", directory.parents[2] / "agent/redact.py")
        load("reference_a2a.protocol", directory / "protocol.py")
        load("reference_a2a.security", directory / "security.py")
        results = exercise(load("reference_a2a.before", directory / "adapter.py", source), False)
        results.update(exercise(load("reference_a2a.after", directory / "adapter.py", patched), True, with_dsh=args.with_dsh, home=home))
        if args.with_dsh:
            results["dshInterop"] = "actual SDK: working receipt and late completed result kept the same task/context"
        print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
