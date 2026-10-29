# Relay HTTP calling protocol

Use this reference when actual Relay MCP/client tools are unavailable. These requests use the existing Connector credential, never an administrator credential. Obtain the HTTPS origin from the configured WSS `/connect` URL, preserving the host/port; do not guess another deployment. Resolve tokens privately in the request process and never forward them to another origin on redirect.

## Read-only discovery

`GET /pairing/targets` with `Authorization: Bearer <existing Connector token>` returns `callerAgentId` and `targets` containing `agentId`, `online`, and `card`. Choose an exact authorized ID. The Connector endpoint currently lists invokable targets; an MCP discovery list can reflect `discover` instead. A list or card alone is not proof that all task actions are allowed. `online` means Relay has a receiving connection; hosted WorkBuddy readiness does not prove the user's desktop is online.

Read `GET /agents/<targetAgentId>/.well-known/agent-card.json` using the same identity and inspect the JSON-RPC endpoint and advertised execution mode. For Relay's WorkBuddy receiver the endpoint is `POST /agents/<targetAgentId>/rpc`.

## Create one task

Before transmitting, replace the example message ID with a new UUID and the text with the user's authorized instruction. Persist the resulting exact body and identifiers privately. Never send placeholder text as a readiness probe.

```json
{
  "jsonrpc": "2.0",
  "id": "send-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "role": "ROLE_USER",
      "messageId": "REPLACE_WITH_STABLE_UUID",
      "parts": [{"text": "REPLACE_WITH_USER_AUTHORIZED_TASK"}]
    }
  }
}
```

Send this JSON with `Content-Type: application/json`, the existing Bearer credential, `Idempotency-Key: <the same stable messageId>`, and `X-Relay-Request-Id: <a preallocated uuid4().hex>`. Generate the request ID once, retain it before sending, and keep all IDs stable during recovery. JSON-encode using a library; do not interpolate task text or tokens into a shell command. Do not enable automatic POST retries.

For a WorkBuddy mode choice, add `"metadata": {"workbuddyMode": "cloud"}` or `"desktop"` **inside `params.message`**. Without it, follow the card's default. Follow-up `contextId` also belongs inside that message. New tasks omit `taskId`; hosted WorkBuddy does not support a supplied taskId for continuation. `ROLE_USER` is the exact wire value, not `user`; text must be inside `parts`.

A successful response commonly contains `result.task.id`, `result.task.contextId`, and `result.task.status.state`; some A2A adapters return a Task directly as `result`. Inspect the actual schema. Save the opaque task ID exactly, including short/non-UUID IDs. A returned task or HTTP 200 is not necessarily task completion; inspect both JSON-RPC `error` and the task state.

## Read your existing task

Use the same target and caller identity. Replace the task ID with the actual returned A2A task ID, not the Relay request ID or WorkBuddy provider session ID.

```json
{
  "jsonrpc": "2.0",
  "id": "get-1",
  "method": "GetTask",
  "params": {"id": "REPLACE_WITH_RETURNED_A2A_TASK_ID"}
}
```

Send to the same `/agents/<targetAgentId>/rpc` with Bearer authentication and JSON content type. `GetTask` requires `task_read` and a stable ownership record for this caller. A grant does not transfer tasks created by another identity. Do not try random task IDs or old-identity tasks to infer invoke permission.

Enterprise Relay rejects `ListTasks` / `tasks/list` with HTTP 501 `rpc_method_not_supported`; older deployments returned 403. The receiver's local listing capability does not change this. Use your saved task IDs, not unfiltered enumeration. Do not request extra invoke grants merely because listing fails.

Other receiver extensions are not automatically exposed by Relay. The current enterprise allowlist includes SendMessage, GetTask, CancelTask, RespondPermission and ReleaseCloudTask (and supported protocol aliases); it does not include ResumeCloudTask or ReconcileCloudTask. Do not try to unlock those extensions with additional grants. For hosted WorkBuddy recovery, keep reading the original GetTask; the receiver schedules eligible read-only recovery internally. Local/legacy CLI capabilities can differ.

## Durable receipts and uncertain sends

Read `GET /relay/requests/<relayRequestId>` with the **same caller credentials**. This endpoint works in enterprise mode. It reports the original request state and, when completed, its `responseBody`; parse that body to get the task/error. Receipt completion is HTTP response completion, not necessarily task completion.

| Identifier | Meaning |
| --- | --- |
| JSON-RPC `id` | Request/response correlation; not the instruction's idempotency key |
| `messageId` / `Idempotency-Key` | Stable instruction identity, scoped to caller, target, and endpoint |
| `X-Relay-Request-Id` / returned `relayRequestId` | Durable receipt ID: 32 lowercase hex characters; retain the actual returned value on deduplication |
| `X-Request-Id` | HTTP diagnostic correlation; it is not always a durable receipt |
| Task `id` / `contextId` | Remote task/conversation handles returned by the target |

Relay reserves dispatches using `Idempotency-Key` or a recognized SendMessage `messageId`. `X-Relay-Request-Id` alone does not create a journal. A malformed send lacking both keys can reach parameter validation without creating a receipt. Completed duplicates return the original receipt ID; persist that value. Altered payload under the same key returns `409 idempotency_conflict`. A 404 receipt may also mean wrong identity, expiry, revoked permission, or no reservation; never infer that the task did not execute, or that enterprise mode has no journal.

On timeout, disconnect, `unknown`, or ownership persistence failure, inspect the original receipt/task without another send. Keep the original IDs even after a cloud execution/result timeout; that timeout does not authorize creating a replacement task. If recovery evidence is unavailable, report the outcome as unknown and inspect the original receiving session. Do not fabricate task IDs or automatically release unresolved tracking to make a new task fit.

## Interpret errors by operation

| Response | Meaning and next step |
| --- | --- |
| HTTP 401 `unauthorized` | Credential invalid/expired/revoked; check the actual caller identity and private credential source |
| HTTP 403 `access_denied` on card/send | Check that operation's grant, token scopes, Agent capabilities/status, enterprise, and personal member intersection; card access does not imply invoke |
| HTTP 403 on GetTask | Check `task_read` **and task ownership**; it does not establish whether SendMessage is allowed |
| HTTP 501 `rpc_method_not_supported` on ListTasks | Enterprise collection listing unavailable; no additional grant enables it |
| JSON-RPC `-32602` user message validation | Check `params.message`, exact role, unique messageId, and text parts; this is not an ACL denial |
| HTTP 409 `idempotency_conflict` | Same key was used with changed input; recover the original attempt instead of replacing it |
| Receipt HTTP 404 `request_not_found` | Missing/inaccessible evidence; not proof of non-execution |
| Timeout, `ownership_unavailable`, unknown outcome | Keep IDs and recover; never automatically submit again under a new ID |

A corrected request with changed input is not an exact retry. When an explicit adapter validation rejection proves no task was created, record that failed attempt before preparing the corrected one; an existing receipt retains the rejected payload and cannot be rewritten using the same idempotency key. Ambiguous errors are not sufficient evidence to create another instruction.

Do not infer “nothing reached WorkBuddy” solely from an empty error `targetAgentId`: older middleware omitted that diagnostic field. Report the exact HTTP status, JSON-RPC error, caller/target IDs and known dispatch evidence, without credentials or task secrets.
