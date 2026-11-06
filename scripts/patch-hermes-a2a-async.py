#!/usr/bin/env python3
"""Check or apply the native Hermes root/local A2A asynchronous-reply repair.

Only the known synchronous SendMessage implementation is accepted. This does
not change authentication, Gateway configuration, credentials, or running tasks.
Restart the target Gateway from an outside terminal after applying the patch.
"""

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import textwrap


VERSION = "connector-native-async-v2"
SUPPORTED_SEND = """\
def _rpc_message_send(self, req_id, params, peer, agent=None, v1_response=False):
    task, pending = self._prepare_task(params, peer, agent=agent)
    if task is None:
        state, reply = self._finalize_task(pending, *self._await_reply(pending))
        task = protocol.build_task(pending["task_id"], pending["context_id"], state, reply, created_at=pending["created_iso"])
    return _ok(req_id, protocol.send_message_response(task) if v1_response else task)
"""
ASYNC_BODY = '''\
"""connector-native-async-v2: retain the native task until its reply arrives."""
configuration = params.get("configuration")
if not (isinstance(configuration, dict) and configuration.get("returnImmediately") is True):
    task, pending = self._prepare_task(params, peer, agent=agent)
    if task is None:
        state, reply = self._finalize_task(pending, *self._await_reply(pending))
        task = protocol.build_task(pending["task_id"], pending["context_id"], state, reply, created_at=pending["created_iso"])
    return _ok(req_id, protocol.send_message_response(task) if v1_response else task)

from agent.memory_provider import spawn_context_thread
task, pending = self._prepare_task(params, peer, agent=agent)
if task is None:
    task = protocol.build_task(pending["task_id"], pending["context_id"], protocol.STATE_WORKING,
                               created_at=pending["created_iso"])

    def completed(future):
        def finalize():
            # set_result marks the Future done before invoking its callbacks.
            # A concurrently registered callback can run before scope capture.
            future._a2a_reply_context_ready.wait()

            def finish():
                try:
                    outcome = future.result()
                except Exception:
                    outcome = (protocol.STATE_FAILED, "[agent reply failed]")
                self._finalize_task(pending, *outcome)

            # Use the completing Gateway turn's actual scope, including when
            # the Future was already done before this callback was registered.
            future._a2a_reply_context.copy().run(finish)

        # Native send()/disconnect() resolve Futures while holding _pending_lock.
        # Finalization takes that lock again; never run it inline in the callback.
        spawn_context_thread(finalize, name="a2a-finalize-" + pending["task_id"], daemon=True).start()

    pending["future"].add_done_callback(completed)
return _ok(req_id, protocol.send_message_response(task) if v1_response else task)
'''
SUPPORTED_PENDING = '''\
def _add_pending(self, task_id, context_id):
    fut = Future()
    with self._pending_lock:
        self._active_tasks.add(task_id)
        self._pending[task_id] = (context_id, fut)
        self._pending_order.setdefault(context_id, deque()).append(task_id)
    return fut
'''
PENDING_BODY = '''\
"""Capture the reply's profile scope before exposing its Future to the Gateway."""
from contextvars import copy_context
from threading import Event
fut = Future()
fut._a2a_reply_context_ready = Event()

def remember_scope(completed):
    completed._a2a_reply_context = copy_context()
    completed._a2a_reply_context_ready.set()

fut.add_done_callback(remember_scope)
with self._pending_lock:
    self._active_tasks.add(task_id)
    self._pending[task_id] = (context_id, fut)
    self._pending_order.setdefault(context_id, deque()).append(task_id)
return fut
'''


def normalized(node):
    node = ast.parse(ast.unparse(node)).body[0]
    class LocalAnnotations(ast.NodeTransformer):
        def visit_AnnAssign(self, assignment):
            if isinstance(assignment.target, ast.Name) and assignment.value is not None:
                return ast.Assign(targets=[assignment.target], value=assignment.value)
            return assignment
    node = LocalAnnotations().visit(node)
    node.returns = None
    for arg in (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs):
        arg.annotation = None
    if node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant) and isinstance(node.body[0].value.value, str):
        node.body.pop(0)
    return ast.dump(node, include_attributes=False)


def patched_source(source):
    tree = ast.parse(source)
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "A2AAdapter"]
    if len(classes) != 1:
        raise ValueError("Expected one native A2AAdapter; this Hermes version is unsupported")
    methods = {node.name: node for node in classes[0].body if isinstance(node, ast.FunctionDef)}
    method = methods.get("_rpc_message_send")
    if method is None:
        raise ValueError("Native SendMessage handler is missing")
    definitions = ((method, SUPPORTED_SEND, ASYNC_BODY), (methods.get("_add_pending"), SUPPORTED_PENDING, PENDING_BODY))
    already_patched = True
    for node, supported, body in definitions:
        if node is None:
            raise ValueError("Native pending-reply implementation is missing")
        expected = ast.parse(supported).body[0]
        repaired = ast.parse(supported.split("\n", 1)[0] + "\n" + textwrap.indent(body, "    ")).body[0]
        matches = normalized(node) == normalized(repaired)
        already_patched = already_patched and matches
        if not matches and normalized(node) != normalized(expected):
            raise ValueError("Native reply handling differs from the supported implementation; refusing to overwrite it")
    # Without these ownership guards the orphan sweep could still fail an
    # accepted asynchronous task when the old reply window elapses.
    pending = methods.get("_add_pending")
    sweep = methods.get("_fail_orphans_once")
    if pending is None or "self._active_tasks.add(task_id)" not in ast.unparse(pending) or sweep is None:
        raise ValueError("Native adapter lacks active-task protection; upgrade Hermes before applying this repair")
    protected = any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "fail_orphans"
                    and any(keyword.arg == "exclude" and isinstance(keyword.value, ast.Name) and keyword.value.id == "active_tasks"
                            for keyword in node.keywords) for node in ast.walk(sweep))
    if not protected or "active_tasks = set(self._active_tasks)" not in ast.unparse(sweep) or "_finalize_task" not in methods:
        raise ValueError("Native adapter lacks a protected orphan sweep or native finalizer")
    if already_patched:
        return source, "already_patched"
    lines = source.splitlines(keepends=True)
    for node, _supported, body in sorted(definitions, key=lambda item: item[0].lineno, reverse=True):
        head = "".join(lines[node.lineno - 1:node.body[0].lineno - 1])
        replacement = head + textwrap.indent(body, " " * (node.col_offset + 4)) + "\n"
        lines[node.lineno - 1:node.end_lineno] = [replacement]
    result = "".join(lines)
    compile(result, "<patched Hermes A2A adapter>", "exec")
    return result, "patchable"


def repair(root, apply=False):
    root = Path(root).expanduser().resolve()
    candidates = (root / "plugins/platforms/a2a/adapter.py", root / "gateway/platforms/a2a.py",
                  root / "gateway/platforms/a2a/adapter.py")
    files = [path.resolve() for path in candidates if path.is_file()]
    if len(files) != 1 or root not in files[0].parents:
        raise ValueError("Expected one native adapter under --hermes-root; use the actual running Hermes source directory")
    path = files[0]
    helper = root / "agent/memory_provider.py"
    if not helper.is_file() or not any(isinstance(node, ast.FunctionDef) and node.name == "spawn_context_thread"
                                       for node in ast.parse(helper.read_text()).body):
        raise ValueError("Hermes lacks its profile-aware thread helper; upgrade Hermes before applying this repair")
    original = path.read_bytes()
    patched, status = patched_source(original.decode("utf-8"))
    result = {"status": status, "version": VERSION, "adapter": str(path), "scope": "root/local native SendMessage"}
    if not apply or status == "already_patched":
        return result
    mode = stat.S_IMODE(path.stat().st_mode)
    backup = path.with_name(path.name + ".before-a2a-async-" + hashlib.sha256(original).hexdigest()[:12])
    if backup.exists():
        if backup.read_bytes() != original:
            raise ValueError("Existing backup differs; refusing to replace it")
    else:
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())
        backup.chmod(mode)
    staged = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".a2a-async-", delete=False) as stream:
            staged = Path(stream.name)
            stream.write(patched.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        staged.chmod(mode)
        if path.read_bytes() != original:
            raise ValueError("Native source changed during repair; refusing to overwrite a concurrent edit")
        os.replace(staged, path)
    finally:
        if staged is not None and staged.exists():
            staged.unlink()
    return dict(result, status="patched", backup=str(backup), restartRequired=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Inspect only; this is the default")
    mode.add_argument("--apply", action="store_true", help="Back up and atomically repair native reply handling")
    args = parser.parse_args()
    try:
        print(json.dumps(repair(args.hermes_root, apply=args.apply), ensure_ascii=False, indent=2))
    except (OSError, ValueError, SyntaxError) as error:
        print(json.dumps({"status": "unsupported", "error": str(error)}, ensure_ascii=False))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
