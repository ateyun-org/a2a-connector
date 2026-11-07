#!/usr/bin/env python3
"""Exercise approval reporting against real native Hermes source on loopback.

Models, tools and the approval decision are controlled; no business command is
executed and --hermes-root is never modified. HTTP, native task/auth code and
the optional DSH SDK/provider are real.
"""

import argparse
import asyncio
import importlib.util
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


def script(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reference = script("native_reference", ROOT / "test/hermes-native-reference.py")
repair = script("approval_repair", ROOT / "scripts/patch-hermes-a2a-approval.py")


def exercise(root, home, with_dsh):
    directory = root / "plugins/platforms/a2a"
    sources = {}
    for name, edits in repair.EDITS.items():
        source = (directory / name).read_text()
        for _, _, _, old, new in edits:
            source = source.replace(new, old)
        sources[name] = source
    sources["adapter.py"], _ = repair.async_repair.patched_source(sources["adapter.py"])
    reference.install_runtime_stubs(home)
    for name, path in (("hermes_cli.home_data_layout", "hermes_cli/home_data_layout.py"),
                       ("agent.file_safety", "agent/file_safety.py"), ("agent.redact", "agent/redact.py")):
        reference.load(name, root / path)
    context = types.ModuleType("tools.approval_context")
    context._get_approval_timeout = lambda: 300
    tools = types.ModuleType("tools")
    tools.__path__ = []
    sys.modules.update({"tools": tools, "tools.approval_context": context})
    stub_tools = types.ModuleType("reference_a2a.tools")
    stub_tools.register_tools = lambda ctx: None
    sys.modules[stub_tools.__name__] = stub_tools
    reference.load("reference_a2a.security", directory / "security.py")
    helper = reference.load("reference_a2a.approval_state", ROOT / "patches/hermes_approval_state.py")
    hooks = {}
    plugin = reference.load("reference_a2a.plugin", directory / "plugin_entry.py",
                            repair.patched_source(sources["__init__.py"], repair.EDITS["__init__.py"]))
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()

    def run(coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, loop).result(timeout=3)

    def phase(patched):
        protocol_source = sources["protocol.py"]
        adapter_source = sources["adapter.py"]
        if patched:
            protocol_source = repair.patched_source(protocol_source, repair.EDITS["protocol.py"])
            adapter_source = repair.patched_source(adapter_source, repair.EDITS["adapter.py"])
        protocol = reference.load("reference_a2a.protocol", directory / "protocol.py", protocol_source)
        native = reference.load("reference_a2a.adapter", directory / "adapter.py", adapter_source)
        plugin.register(types.SimpleNamespace(register_hook=lambda name, callback: hooks.update({name: callback}),
                                              register_platform=lambda **kwargs: None))
        assert set(hooks) == {"pre_approval_request", "post_approval_response"}
        adapter = native.A2AAdapter(types.SimpleNamespace(extra={"port": 0}))
        assert run(adapter.connect())

        def request(method, params, token="connector-reference-secret"):
            data = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{adapter._httpd.server_port}/", data=data,
                                         headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=3) as response:
                    return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                return error.code, json.load(error)

        def send(index):
            return request("SendMessage", {"message": {"messageId": f"approval-reference-{index}",
                           "role": "ROLE_USER", "parts": [{"text": "controlled approval observation"}]},
                           "configuration": {"returnImmediately": True}})[1]["result"]["task"]

        def get(task):
            return request("GetTask", {"id": task["id"]})[1]["result"]

        def event(task, tool="call-1"):
            return {"session_key": "agent:main:a2a:dm:" + task["contextId"], "turn_id": "turn-1",
                    "tool_call_id": tool, "command": "echo PRIVATE_COMMAND_CANARY password=PRIVATE_SECRET_CANARY",
                    "description": "PRIVATE_DESCRIPTION_CANARY"}

        def finish(task, text="Receiver final response"):
            run(adapter.send(task["contextId"], text, metadata={"notify": True}))
            deadline = time.monotonic() + 2
            while task["id"] in adapter._pending and time.monotonic() < deadline:
                time.sleep(0.005)
            assert task["id"] not in adapter._pending
            return get(task)

        try:
            task = send(1)
            hooks["pre_approval_request"](**event(task))
            run(adapter.send(task["contextId"], "PRIVATE_PROMPT_CANARY", metadata={"is_approval_prompt": True}))
            if not patched:
                assert get(task)["status"]["state"] == protocol.STATE_WORKING
                assert "hermesApproval" not in get(task).get("metadata", {})
                return {"before": "reproduced ignored approval notification and WORKING state"}
            paused = get(task)
            assert paused["status"]["state"] == protocol.STATE_INPUT_REQUIRED
            approval = paused["metadata"]["hermesApproval"]
            assert approval["reasonCode"] == "approval_required" and approval["commandExecuted"] is False
            assert approval["requests"][0]["requestId"] and approval["requests"][0]["expiresAt"]
            assert "CANARY" not in json.dumps(paused)
            assert request("GetTask", {"id": task["id"]}, "invalid-token")[0] == 401
            assert request("GetTask", {"id": task["id"]}, "untrusted-reference-secret")[0] == 403
            other = send(2)
            assert get(other)["status"]["state"] == protocol.STATE_WORKING
            original_home = sys.modules["hermes_constants"].get_hermes_home
            sys.modules["hermes_constants"].get_hermes_home = lambda: Path(home) / "another-profile"
            try:
                hooks["pre_approval_request"](**event(other))
                assert get(other)["status"]["state"] == protocol.STATE_WORKING
            finally:
                sys.modules["hermes_constants"].get_hermes_home = original_home
            hooks["post_approval_response"](**event(task), choice="timeout")
            timed_out = finish(task, "Model omitted the INPUT_REQUIRED marker")
            assert timed_out["status"]["state"] == protocol.STATE_FAILED
            assert timed_out["metadata"]["hermesApproval"]["reasonCode"] == "approval_timeout"
            assert timed_out["metadata"]["hermesApproval"]["commandExecuted"] is False
            assert "did not execute" in str(timed_out)
            hooks["pre_approval_request"](**event(other))
            hooks["pre_approval_request"](**event(other, "parallel-call"))
            hooks["post_approval_response"](**event(other), choice="once")
            assert get(other)["status"]["state"] == protocol.STATE_INPUT_REQUIRED
            hooks["post_approval_response"](**event(other, "parallel-call"), choice="session")
            assert get(other)["status"]["state"] == protocol.STATE_WORKING
            done = finish(other)
            assert done["id"] == other["id"] and done["contextId"] == other["contextId"]
            assert done["status"]["state"] == protocol.STATE_COMPLETED
            denied = send(3)
            hooks["pre_approval_request"](**event(denied))
            hooks["post_approval_response"](**event(denied), choice="deny")
            assert finish(denied)["status"]["state"] == protocol.STATE_REJECTED
            undeliverable = send(4)
            hooks["pre_approval_request"](**event(undeliverable))
            hooks["post_approval_response"](**event(undeliverable), choice="notify_failed")
            failed = finish(undeliverable)
            assert failed["status"]["state"] == protocol.STATE_FAILED
            assert failed["metadata"]["hermesApproval"]["reasonCode"] == "approval_notification_failed"
            if with_dsh:
                original_handle = adapter.handle_message
                async def handle(event_value):
                    await original_handle(event_value)
                    await asyncio.sleep(0.03)
                    hooks["pre_approval_request"](**event({"contextId": event_value.source.chat_id}))
                adapter.handle_message = handle
                client = r'''
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { A2AOrchestrator } = await import(pathToFileURL(process.argv[3]).href);
const client = new A2AOrchestrator({ storePath: process.argv[2], pollIntervalMs: 10, taskTimeoutMs: 2000,
  agents: [{ id: 'receiver', url: process.argv[1], allowHttp: true, tokenEnv: 'A2A_REFERENCE_TOKEN' }] });
const run = await client.startRun('receiver', { parent: { session: { id: 'approval-reference-parent' } },
  prompt: [{ type: 'text', text: 'controlled approval test' }], signal: new AbortController().signal });
const result = await run.result;
assert.equal(result.stopReason, 'error');
assert.match(result.diagnostic, /approval_required/);
assert.equal(result.task.approval.commandExecuted, false);
await run.dispose();
const task = await client.getTask(run.id, 'approval-reference-parent');
assert.equal(task.metadata.hermesApproval.status, 'pending');
console.log(JSON.stringify({ pendingVisible: true, taskPreserved: true }));
'''
                response = subprocess.run(["node", "--input-type=module", "-e", client,
                    f"http://127.0.0.1:{adapter._httpd.server_port}", str(Path(home) / "dsh-approvals.json"),
                    str(ROOT / "plugins/dsh/orchestrator.js")], capture_output=True, text=True, timeout=6,
                    env=dict(os.environ, A2A_REFERENCE_TOKEN="connector-reference-secret"))
                assert response.returncode == 0, response.stderr
                assert json.loads(response.stdout)["taskPreserved"]
            return {"after": "pending, timeout, approval/resume, denial and delivery failure verified on original tasks",
                    "isolation": "other task/profile and unauthorized peers unchanged; no command/secret text exposed",
                    "dsh": "actual SDK/provider received approval immediately without cancellation or resend" if with_dsh else "not requested"}
        finally:
            run(adapter.disconnect())

    try:
        results = phase(False)
        results.update(phase(True))
        return results
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", required=True)
    parser.add_argument("--with-dsh", action="store_true")
    args = parser.parse_args()
    for name in list(os.environ):
        if name.startswith("A2A_"):
            del os.environ[name]
    os.environ.update(A2A_PEER_TOKENS="connector:connector-reference-secret,untrusted:untrusted-reference-secret",
                      A2A_TRUSTED_PEERS="connector")
    with tempfile.TemporaryDirectory(prefix="hermes-approval-home-") as home:
        print(json.dumps(exercise(Path(args.hermes_root).resolve(), home, args.with_dsh), indent=2))


if __name__ == "__main__":
    main()
