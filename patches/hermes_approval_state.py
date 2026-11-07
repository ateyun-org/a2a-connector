"""Observe native Hermes approvals without granting or changing permissions.

Installed beside the native A2A adapter by patch-hermes-a2a-approval.py.
Only fixed summaries and opaque correlation IDs leave the receiver. Commands,
approval reasons and credentials are never copied into A2A task metadata.
"""

from datetime import datetime, timezone, timedelta
import hashlib
import json
import logging
import threading
import weakref


VERSION = "approval-state-v1"
_adapters = weakref.WeakKeyDictionary()
_lock = threading.RLock()
_messages = {
    "pending": ("approval_required", "Waiting for receiver operator approval; the guarded command has not executed."),
    "approved": ("approval_approved", "Operator approval received; the original task may continue."),
    "timed_out": ("approval_timeout", "Operator approval timed out; the guarded command did not execute."),
    "denied": ("approval_denied", "Operator approval was denied; the guarded command did not execute."),
    "cancelled": ("approval_cancelled", "The approval request was withdrawn; the guarded command did not execute."),
    "notify_failed": ("approval_notification_failed", "The receiver could not deliver the approval request; the guarded command did not execute."),
}
logger = logging.getLogger(__name__)


def bind(adapter):
    from hermes_constants import get_hermes_home
    with _lock:
        _adapters[adapter] = str(get_hermes_home().resolve())


def register_hooks(ctx):
    ctx.register_hook("pre_approval_request", requested)
    ctx.register_hook("post_approval_response", settled)


def _identity(event):
    # The host does not include its interactive request ID in these hooks.
    # This ID correlates observations only; it cannot authorize a command.
    fields = [event.get(key, "") for key in ("session_key", "turn_id", "tool_call_id", "command")]
    digest = hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode()).hexdigest()[:24]
    return "approval-" + digest


def _utc():
    return datetime.now(timezone.utc)


def _targets(session_key):
    from hermes_constants import get_hermes_home
    if ":a2a:" not in session_key:
        return []
    home = str(get_hermes_home().resolve())
    with _lock:
        adapters = [adapter for adapter, owner in _adapters.items() if owner == home]
    targets = []
    for adapter in adapters:
        with adapter._pending_lock:
            for context, order in adapter._pending_order.items():
                if not session_key.endswith(":" + context):
                    continue
                # Match the native adapter's oldest unresolved turn, never another
                # task/profile or a turn whose final reply is already in flight.
                for task_id in order:
                    pending = adapter._pending.get(task_id)
                    if pending and not pending[1].done():
                        targets.append((adapter, task_id))
                        break
    return targets


def _update(status, event):
    from . import protocol
    identity = _identity(event)
    now = _utc()
    for adapter, task_id in _targets(str(event.get("session_key") or "")):
        with adapter.tasks._lock:
            rec = adapter.tasks._tasks.get(task_id)
            if rec is None:
                continue
            previous = rec.get("hermes_approval", {})
            requests = {item["requestId"]: dict(item) for item in previous.get("requests", [])}
            if status == "pending":
                if rec["state"] in protocol.TERMINAL_STATES or requests.get(identity, {}).get("status") == "pending":
                    continue
                expiry = None
                try:
                    from tools.approval_context import _get_approval_timeout
                    expiry = (now + timedelta(seconds=_get_approval_timeout())).isoformat()
                except (ImportError, ValueError, OverflowError):
                    pass
                requests[identity] = {"requestId": identity, "status": status,
                                      "requestedAt": now.isoformat(), "expiresAt": expiry}
            elif identity not in requests:
                continue
            else:
                requests[identity].update(status=status, updatedAt=now.isoformat())
            items = list(requests.values())
            pending = [item for item in items if item["status"] == "pending"]
            blocked = [item for item in items if item["status"] != "approved"]
            overall = (pending or blocked or items)[-1]["status"]
            reason, message = _messages[overall]
            observation = {"version": VERSION, "status": overall, "reasonCode": reason,
                           "summary": message, "requests": items, "updatedAt": now.isoformat(),
                           "resolution": "receiver_operator_approval", "canRespondViaA2A": False}
            if overall != "approved":
                observation["commandExecuted"] = False
            rec["hermes_approval"] = observation
            if rec["state"] not in protocol.TERMINAL_STATES:
                rec["state"] = protocol.STATE_WORKING if overall == "approved" else protocol.STATE_INPUT_REQUIRED
                rec["reply"] = message
            state = rec["state"]
        logger.info("A2A approval task=%s state=%s reason=%s request=%s", task_id, state, reason, identity)


def requested(**event):
    _update("pending", event)


def settled(**event):
    choice = event.get("choice")
    status = ("approved" if choice in ("once", "session", "always") else
              "denied" if choice == "deny" else
              "notify_failed" if choice == "notify_failed" else
              "cancelled" if choice == "cancelled" else "timed_out")
    _update(status, event)


def decorate_task(task, rec):
    observation = rec.get("hermes_approval")
    if observation:
        task.setdefault("metadata", {})["hermesApproval"] = observation
        task["status"]["timestamp"] = observation["updatedAt"]
    return task


def finalize(adapter, pending, state, reply):
    from . import protocol
    rec = adapter.tasks.get(pending["task_id"])
    observation = (rec or {}).get("hermes_approval")
    if state == protocol.STATE_COMPLETED and observation and observation["status"] != "approved":
        status = observation["status"]
        state = (protocol.STATE_REJECTED if status == "denied" else
                 protocol.STATE_FAILED if status in ("timed_out", "notify_failed") else
                 protocol.STATE_CANCELED if status == "cancelled" else protocol.STATE_INPUT_REQUIRED)
        reply = observation["summary"] + ("\n\n" + reply if reply else "")
    return state, reply
