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

## List only your tasks

Use `ListTasks` (alias `tasks/list`) on the same authenticated target RPC endpoint:

```json
{"jsonrpc":"2.0","id":"list-1","method":"ListTasks","params":{"pageSize":50}}
```

Requires `task_read`, credential `call` scope, and the same live machine/member authorization as GetTask. Relay filters provider tasks using MySQL task **and context** ownership; unknown/unbound tasks and other callers are omitted. It computes `totalSize` and pagination only after filtering. No global task count or provider cursor is returned. No extra invoke grant is needed for listing itself. A target that does not implement ListTasks returns its unsupported-method error.

Optional filters: `contextId`, `status` (for example `TASK_STATE_WORKING`), and inclusive RFC3339 `statusTimestampAfter`. `pageSize` defaults to 50, maximum 100. `historyLength` defaults to 0 (maximum 1000); `includeArtifacts` defaults to false. Relay also enforces filtering/projection when the provider ignores those parameters.

The result contains `tasks`, `totalSize`, `pageSize` and `nextPageToken`. Pass the returned Relay token with identical filters/page size and the same caller/target/endpoint. Pages are a stable snapshot for five minutes; a fresh list refreshes status. Permissions and ownership are rechecked on each page, so revocation immediately stops access. Expired, forged or mismatched tokens return JSON-RPC -32602. Scans are bounded to 100 provider pages, 10000 tasks and 16 MiB; over-limit/malformed/repeating provider pagination fails without returning an unfiltered or partial collection.

MCP exposes `a2a_tasks({targetAgentId,...filters})`. WorkBuddy CLI exposes `workbuddy-a2a tasks TARGET [--page-size N] [--page-token TOKEN] [--context-id ID] [--status STATE] [--history-length N] [--include-artifacts]`.

A list omission does not prove an uncertain send never executed: ownership may not have been durably bound or the provider may have pruned the task. Preserve original IDs and use the original receipt/GetTask for recovery; do not resend merely because listing is empty. Older Relay releases return 501 for ListTasks and require upgrading, not extra grants.

Receiver extensions require an explicit Relay method mapping. Relay releases reporting `workbuddyNativeVersion:"completion-recovery-v3"` expose ReconcileCloudTask with `task_read` and ResumeCloudTask with **both** `task_read` and `invoke`; both require the original caller's task ownership. Resume only handles a known session whose business prompt was never attempted. Earlier releases reject these two methods before forwarding; extra grants cannot enable a missing mapping. GetTask plus the hosted receiver's automatic read-only recovery remains available. Local receiver capabilities can differ.

CancelTask requires `task_cancel`, RespondPermission requires `permission_respond`, and ReleaseCloudTask requires `tracking_release`, each with task ownership. Personal callers additionally need the corresponding member direct/group grants intersected with explicit machine grants. A flat Relay 403 can indicate a missing action grant or wrong ownership; administrator status does not bypass either. Authorized calls to unsupported target methods retain JSON-RPC -32601. Authorization alone does not guarantee a control can run: cancellation requires a usable live connection; release requires an unresolved task without a live connection or active recovery, verified provider inactivity, and explicit user intent.

Native WorkBuddy URI-only artifacts use `parts[].url` with `metadata.contentAvailability:"reference_only"`; actual provider text uses `parts[].text` with `contentAvailability:"inline"`. An `agent:///...` URI is a provider workspace reference, not inline contents or a Relay download endpoint. A reference does not establish successful completion. Preserve recovered inline output even while completion remains unverified.

## Download a registered WorkBuddy file

Relay health `workbuddyArtifactVersion:"download-v1"` and the native Agent Card's `metadata.artifactDownloadMethod:"GetArtifact"` identify support. Call this read-only extension on the target's JSONRPC endpoint:

```json
{"jsonrpc":"2.0","id":"file-1","method":"GetArtifact","params":{"id":"ORIGINAL_A2A_TASK_ID","artifactId":"agent:///workspace/relay-doctor.mjs","maxBytes":8388608}}
```

Requires `task_read`, original task ownership and live caller authorization. Card discovery additionally requires `discover`. Personal callers need the corresponding member/machine grant intersection. It works independently of pending task state; it does not submit instructions, approve permissions, cancel, release tracking, or create a dispatch receipt. Keep using the original task ID even when completion remains unknown.

The server reads only an artifact registered in the original cloud session. It verifies task identity and gets a fresh task ticket, uses inline provider text or downloads the registered media file via Entry.url / sandbox path, and refreshes an expired ticket once. No arbitrary URL/path parameter is accepted. Tickets stay on the original sandbox origin; signed external URLs receive no ticket. Redirects and private/reserved network addresses are blocked. Signed URLs/tickets are never included in results or journals. Sandbox ACP links ending in `/acp` are supported; gateway-only `/sessions/...` links report an unsupported endpoint.

The result is `{artifact:{artifactId,name,parts:[{raw,filename,mediaType}],metadata:{contentAvailability:"inline",sizeBytes,sha256}}}`. `raw` is Base64 of exact file bytes. Verify size and SHA-256 before writing. `maxBytes` defaults to 8 MiB and may only reduce that bound; reads are bounded and never partial-success downloads. -32602 means invalid parameters/non-file artifact, -32001 means missing/deleted artifact, -32003 means over the byte limit, and -32002 means unavailable upstream/session. Unsupported targets return -32601. None of these errors authorizes resending work.

CLI: `workbuddy-a2a artifact TARGET TASK_ID 'agent:///workspace/relay-doctor.mjs' --output ./relay-doctor.mjs` verifies integrity and writes mode 0600 without overwriting an existing file. MCP: `a2a_artifact({targetAgentId,taskId,artifactId})` reads up to 512 KiB, returning UTF-8 text inline or binary Base64 raw bytes. Do not probe arbitrary RPC methods or HTTP paths for file contents.

## Durable receipts and uncertain sends

Read `GET /relay/requests/<relayRequestId>` with the **same caller credentials**. This endpoint works through Relay. It reports the original request state and, when completed, its `responseBody`; parse that body to get the task/error. Receipt completion is HTTP response completion, not necessarily task completion.

| Identifier | Meaning |
| --- | --- |
| JSON-RPC `id` | Request/response correlation; not the instruction's idempotency key |
| `messageId` / `Idempotency-Key` | Stable instruction identity, scoped to caller, target, and endpoint |
| `X-Relay-Request-Id` / returned `relayRequestId` | Durable receipt ID: 32 lowercase hex characters; retain the actual returned value on deduplication |
| `X-Request-Id` | HTTP diagnostic correlation; it is not always a durable receipt |
| Task `id` / `contextId` | Remote task/conversation handles returned by the target |

Relay reserves dispatches using `Idempotency-Key` or a recognized SendMessage `messageId`. `X-Relay-Request-Id` alone does not create a journal. A malformed send lacking both keys can reach parameter validation without creating a receipt. Completed duplicates return the original receipt ID; persist that value. Altered payload under the same key returns `409 idempotency_conflict`. A 404 receipt may also mean wrong identity, expiry, revoked permission, or no reservation; never infer that the task did not execute, or that Relay has no journal.

On timeout, disconnect, `unknown`, or ownership persistence failure, inspect the original receipt/task without another send. Keep the original IDs even after a cloud execution/result timeout; that timeout does not authorize creating a replacement task. If recovery evidence is unavailable, report the outcome as unknown and inspect the original receiving session. Do not fabricate task IDs or automatically release unresolved tracking to make a new task fit.

## Interpret errors by operation

| Response | Meaning and next step |
| --- | --- |
| HTTP 401 `unauthorized` | Credential invalid/expired/revoked; check the actual caller identity and private credential source |
| HTTP 403 `access_denied` on card/send | Check that operation's grant, token scopes, Agent capabilities/status, enterprise, and personal member intersection; card access does not imply invoke |
| HTTP 403 on GetTask | Check `task_read` **and task ownership**; it does not establish whether SendMessage is allowed |
| Unsupported ListTasks | Check Relay/provider version and capability; do not request extra invoke grants or resend |
| JSON-RPC `-32602` user message validation | Check `params.message`, exact role, unique messageId, and text parts; this is not an ACL denial |
| HTTP 409 `idempotency_conflict` | Same key was used with changed input; recover the original attempt instead of replacing it |
| Receipt HTTP 404 `request_not_found` | Missing/inaccessible evidence; not proof of non-execution |
| Timeout, `ownership_unavailable`, unknown outcome | Keep IDs and recover; never automatically submit again under a new ID |

A corrected request with changed input is not an exact retry. When an explicit adapter validation rejection proves no task was created, record that failed attempt before preparing the corrected one; an existing receipt retains the rejected payload and cannot be rewritten using the same idempotency key. Ambiguous errors are not sufficient evidence to create another instruction.

Do not infer “nothing reached WorkBuddy” solely from an empty error `targetAgentId`: older middleware omitted that diagnostic field. Report the exact HTTP status, JSON-RPC error, caller/target IDs and known dispatch evidence, without credentials or task secrets.
