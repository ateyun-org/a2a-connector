#!/usr/bin/env python3
"""Check/apply native Hermes approval-state reporting, including the async repair.

No approvals are granted, no commands are submitted, and no configuration is
changed. Restart the Gateway from an outside terminal after applying.
"""

import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile


ROOT = Path(__file__).resolve().parents[1]
VERSION = "connector-approval-state-v1"
spec = importlib.util.spec_from_file_location("native_async_repair", ROOT / "scripts/patch-hermes-a2a-async.py")
async_repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(async_repair)

# Hashes of the exercised native method bodies. Source outside these methods
# is preserved; an untested host fails closed.
EDITS = {
    "adapter.py": (
        ("A2AAdapter", "connect", "bce78b5af2652f0bc67ce9314a3d643f4fd18928d1d817e3f8e54e938864d305",
         "        self._loop = asyncio.get_running_loop()",
         "        self._loop = asyncio.get_running_loop()\n        from .approval_state import bind\n        bind(self)"),
        ("A2AAdapter", "_finalize_task", "c49bc94555b9aaa9415e79f59be89b34f170dab97a9c2e6fabb74199bea65125",
         '            reply = security.redact_outbound(reply or "")',
         '            reply = security.redact_outbound(reply or "")\n            from .approval_state import finalize\n            state, reply = finalize(self, pending, state, reply)'),
    ),
    "protocol.py": (
        ("TaskStore", "to_task", "7b3a4705b1fa6cda8780640646ea719842ffdfd205bb49a175b54e1512b47b05",
         "        return task", "        from .approval_state import decorate_task\n        return decorate_task(task, rec)"),
    ),
    "__init__.py": (
        (None, "register", "a5f8c25f31371f4d1b28e1cf3a4cc2b012f96aa48bdab553a943d25c1e19646c",
         "        from .adapter import A2AAdapter",
         "        from .adapter import A2AAdapter\n        from .approval_state import register_hooks\n        register_hooks(ctx)"),
    ),
}


def patched_source(source, edits):
    for owner, name, digest, old, new in edits:
        tree = ast.parse(source)
        scope = tree.body
        if owner:
            classes = [node for node in scope if isinstance(node, ast.ClassDef) and node.name == owner]
            if len(classes) != 1:
                raise ValueError(f"Unsupported native class: {owner}")
            scope = classes[0].body
        methods = [node for node in scope if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        if len(methods) != 1:
            raise ValueError(f"Unsupported native method: {name}")
        node = methods[0]
        lines = source.splitlines(keepends=True)
        method = "".join(lines[node.lineno - 1:node.end_lineno])
        original = method.replace(new, old) if method.count(new) == 1 else method
        if hashlib.sha256(original.encode()).hexdigest() != digest:
            raise ValueError(f"Native {owner or 'plugin'}.{name} differs from the tested implementation")
        if original == method:
            if method.count(old) != 1:
                raise ValueError(f"Native patch anchor is ambiguous: {name}")
            lines[node.lineno - 1:node.end_lineno] = [method.replace(old, new)]
            source = "".join(lines)
    compile(source, "<native approval-state repair>", "exec")
    return source


def repair(root, apply=False):
    root = Path(root).expanduser().resolve()
    async_repair.repair(root)  # Validate the host's profile-aware thread helper, too.
    directory = root / "plugins/platforms/a2a"
    originals, desired = {}, {}
    for name, edits in EDITS.items():
        path = directory / name
        if not path.is_file() or root not in path.resolve().parents:
            raise ValueError("Expected the native platform under --hermes-root")
        original = path.read_bytes()
        source = original.decode("utf-8")
        if name == "adapter.py":
            source, _ = async_repair.patched_source(source)
        originals[path] = original
        desired[path] = patched_source(source, edits).encode()
    helper = directory / "approval_state.py"
    payload = (ROOT / "patches/hermes_approval_state.py").read_bytes()
    compile(payload, str(helper), "exec")
    if helper.exists() and helper.read_bytes() != payload:
        raise ValueError("Existing approval_state.py differs from this managed repair")
    originals[helper] = helper.read_bytes() if helper.exists() else None
    desired = {helper: payload, **desired}
    changes = [path for path in desired if desired[path] != originals[path]]
    result = {"status": "patchable" if changes else "already_patched", "version": VERSION,
              "files": [str(path) for path in changes], "scope": "root/local native A2A approval observations"}
    if not apply or not changes:
        return result
    backups, staged, committed = [], {}, []
    try:
        for path in changes:
            original = originals[path]
            mode = stat.S_IMODE(path.stat().st_mode) if original is not None else 0o644
            if original is not None:
                backup = path.with_name(path.name + ".before-a2a-approval-" + hashlib.sha256(original).hexdigest()[:12])
                if backup.exists() and backup.read_bytes() != original:
                    raise ValueError("Existing backup differs from original source")
                if not backup.exists():
                    with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode), "wb") as stream:
                        stream.write(original)
                        stream.flush()
                        os.fsync(stream.fileno())
                backups.append(str(backup))
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".a2a-approval-", delete=False) as stream:
                staged[path] = Path(stream.name)
                stream.write(desired[path])
                stream.flush()
                os.fsync(stream.fileno())
            staged[path].chmod(mode)
        for path in changes:
            current = path.read_bytes() if path.exists() else None
            if current != originals[path]:
                raise ValueError("Native source changed during repair")
        for path in changes:
            os.replace(staged[path], path)
            committed.append(path)
    except BaseException:
        for path in reversed(committed):
            if path.read_bytes() != desired[path]:
                continue  # Preserve a concurrent writer's work.
            if originals[path] is None:
                path.unlink()
            else:
                path.write_bytes(originals[path])
        raise
    finally:
        for path in staged.values():
            path.unlink(missing_ok=True)
    return dict(result, status="patched", backups=backups, restartRequired=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(repair(args.hermes_root, args.apply), ensure_ascii=False, indent=2))
    except (OSError, ValueError, SyntaxError) as error:
        print(json.dumps({"status": "unsupported", "error": str(error)}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
