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

Relay health `workbuddyArtifactVersion:"download-v1"`, `"download-v2"`, `"download-v3"`, `"download-v4"` or `"download-v5"` and the native Agent Card's `metadata.artifactDownloadMethod:"GetArtifact"` identify support. `download-v2` additionally advertises `artifactDownloadVersion` on the card. Call this read-only extension on the target's JSONRPC endpoint:

```json
{"jsonrpc":"2.0","id":"file-1","method":"GetArtifact","params":{"id":"ORIGINAL_A2A_TASK_ID","artifactId":"agent:///workspace/relay-doctor.mjs","maxBytes":8388608}}
```

Requires `task_read`, original task ownership and live caller authorization. Card discovery additionally requires `discover`. Personal callers need the corresponding member/machine grant intersection. It works independently of pending task state; it does not submit instructions, approve permissions, cancel, release tracking, or create a dispatch receipt. Keep using the original task ID even when completion remains unknown.

The server reads only an artifact registered in the original cloud session. It verifies task identity and gets a fresh task ticket, uses inline provider text or downloads the registered media file via Entry.url / sandbox path, and refreshes an expired ticket once. No arbitrary URL/path parameter is accepted. Tickets stay on the original sandbox origin; signed external URLs receive no ticket. Redirects and private/reserved network addresses are blocked. Signed URLs/tickets are never included in results or journals. Sandbox ACP links ending in `/acp` are supported; gateway-only `/sessions/...` links report an unsupported endpoint.

`download-v2` accepts registered relative Entry URLs and falls back once from an unavailable/stale Entry URL to the exact registered sandbox path, without following redirect locations or bypassing byte limits. Its preferred URL has an eight-second subdeadline. Failed list/file reads include `error.data.stage`, `artifactRegistered` when known, `retryable`, and `attempts:[{source,reason,httpStatus?,retryable}]`; source is `artifact_list`, `entry_url`, `sandbox_data` (v3) or `sandbox_path`. Only fixed classifications/status codes are exposed. For example, `artifact_download`, registered=true, Entry HTTP 403 and sandbox HTTP 404 means registration was verified but both byte reads failed; it does not prove the whole session expired. A plain -32002 from v1 cannot distinguish these causes. Network/timeouts, 408/429/5xx and ticket expiry are retryable; other HTTP/validation failures require investigation instead of unchanged tight polling. A failed file path is not the same as an unregistered artifact (-32001). The CLI displays the safe stage/status summary and MCP preserves the error data.

`download-v3` uses the verified original task's supplied `sandboxDataLink` between Entry URL and legacy ACP path attempts. Only an HTTPS envd origin with port prefix `49983`, exactly matching the original `65225` ACP sandbox ID and region, is eligible. The request is `GET /files?path=<registered-absolute-path>`. Data hostnames are never guessed; the ACP ticket is never sent to envd. No envd access-token contract is available in this task response, so the read is anonymous; envd 401/403 is reported without retrying ACP credentials. Success includes `metadata.downloadSource`. Each preferred source has an eight-second subdeadline within the overall read deadline.

Native `completion-recovery-v4` consumes request-scoped POST SSE as well as GET SSE. A missing user echo no longer blocks text delivered on the original prompt response stream. Unmatched live GET text remains available as separate inline artifacts with `outputVerified:false` (four candidates / 512 KiB total), never as completion evidence. History and other provider turns are not merged into the verified answer; no prompt is automatically resent.

The result is `{artifact:{artifactId,name,parts:[{raw,filename,mediaType}],metadata:{contentAvailability:"inline",sizeBytes,sha256}}}`. `raw` is Base64 of exact file bytes. Verify size and SHA-256 before writing. `maxBytes` defaults to 8 MiB and may only reduce that bound; reads are bounded and never partial-success downloads. -32602 means invalid parameters/non-file artifact, -32001 means missing/deleted artifact, -32003 means over the byte limit, and -32002 means unavailable upstream/session. Unsupported targets return -32601. None of these errors authorizes resending work.

CLI: `workbuddy-a2a artifact TARGET TASK_ID 'agent:///workspace/relay-doctor.mjs' --output ./relay-doctor.mjs` verifies integrity and writes mode 0600 without overwriting an existing file. MCP: `a2a_artifact({targetAgentId,taskId,artifactId})` reads up to 512 KiB, returning UTF-8 text inline or binary Base64 raw bytes. Do not probe arbitrary RPC methods or HTTP paths for file contents.

## Read server-side task diagnostics

Relay health `workbuddyDiagnosticsVersion:"diagnostics-v1"` and native card metadata `taskDiagnosticsMethod:"GetTaskDiagnostics"` identify support. Use the original caller/target and A2A task ID on the same JSONRPC endpoint:

```json
{"jsonrpc":"2.0","id":"diag-1","method":"GetTaskDiagnostics","params":{"id":"ORIGINAL_A2A_TASK_ID"}}
```

Requires `task_read` and task ownership, with the usual personal member/machine grant intersection. Card lookup also needs discover. The receiver refreshes only the original cloud task metadata, verifies its identity, and returns `{taskId,contextId,state,dispatchState,diagnostics,upstreamRefresh}`. It works for retained released/terminal tasks without claiming a slot, changing task status/timestamp, sending work, opening ACP, or creating a dispatch receipt. A failed refresh sets `upstreamRefresh.succeeded:false`; cached observations retain their original timestamp.

`diagnostics.upstream` contains separate sanitized shapes of link/sandboxLink/sandboxDataLink: scheme, host/port and redacted path. Query values, user info, fragments, tickets, unknown path segments and signed URLs are omitted. `artifactBasePolicy` / `sandboxDataLinkEligible` / `sandboxDataLinkRejection` / `sandboxDataLinkUsed` describe the file mapping, validated eligibility and the latest read in the current diagnostic snapshot, not proof of file existence. These fields are for diagnosis only; never construct authenticated requests from them.

`diagnostics.execution` and `diagnostics.recovery` are separate bounded ACP summaries: local request IDs, per-method POST HTTP status/content type, frame counts by GET/POST channel, matched/unmatched response counts and last-response channel, numeric response ID/type, recognized stop-reason presence, session/provider correlation counts, recognized provider-field presence/types, accepted/ignored answer chunks, and fixed failure stage/reason. No raw frames or body text are exposed. GetTask.metadata.diagnostics also carries recorded summaries and a live execution snapshot. Checkpoints retain sanitized summaries in the encrypted task journal. Older/crashed tasks explicitly return executionCapture/recoveryCapture=not_recorded; do not interpret missing instrumentation as zero upstream messages. Endpoint refresh cannot reconstruct historical ACP traffic.

CLI: `workbuddy-a2a diagnostics TARGET TASK_ID`. MCP: `a2a_diagnostics({targetAgentId,taskId})`. Neither requires a target-side CLI. Native hosted WorkBuddy connects ACP inside the Go Relay process. A cloud-task metadata command does not provide a historical raw ACP transcript.

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

## Native receive liveness and URL rejection details

`completion-recovery-v5` closes a locally silent ACP connection after two minutes with no bytes across GET and POST SSE. Heartbeats/data on either channel reset the timer; a pending human permission suspends it until the explicit decision is sent. A cutoff leaves `INPUT_REQUIRED / unknown` and does not cancel remote work, resend, release tracking, or authorize another task. Reconcile/read the original task and release only after verified inactivity. Heartbeating streams still use the absolute 30-minute prompt deadline. Diagnostics add `lastByteAt`, `bytesReceived`, `receiveIdleTimeoutMs`, and the `receive_idle_timeout` failure reason; they do not prove a TCP half-open condition.

`download-v4` canonicalizes HTTPS data-origin default port 443 and DNS host case. It supports both CloudStudio and AgentOS: `65225-<opaque-id>.<region>.agentos-run.net` ACP and the provider-supplied `49983-<opaque-id>.<region>.agentos-run.net` data origin must match ID, region and domain family. AgentOS IDs are alphanumeric, not constrained to CloudStudio's 32 hex digits. Cross-family pairs return `sandbox_family_mismatch`, even if ID and region match. A rejected data URL adds a fixed `attempts[].rejection` and `upstream.sandboxDataLinkRejection`, such as `data_query_not_supported`, `data_path_not_supported`, `acp_origin_not_sandbox`, `sandbox_id_mismatch`, `sandbox_region_mismatch` or `sandbox_family_mismatch`. No query values, credentials or arbitrary URL content are exposed. CLI summaries include all three Entry/data/ACP attempts and whitelisted rejection codes. A rejected signed/gateway URL needs the provider's supported file-access contract; never forward ACP credentials to it by guesswork.


## Provider file access and output integrity

`download-v5` reports safe original-session registration evidence in download failures: `error.data.registration:{entryURLPresent,entryURLKind}` (absent / relative / absolute / provider_reference / invalid). These fields come from the actual REST Entry, not from the public task artifact view. Public `agent:///` parts intentionally omit signed Entry URLs; their presence alone does not establish that Entry.url is missing. When there is no usable Entry URL, envd reports authentication_required and the legacy ACP file path is 404, `blocker:provider_file_access_contract` identifies a missing provider access route. A registered relative Entry URL is already supported and needs no new envd credentials. Only the provider can supply the working URL or a documented distinct data credential. Repeating the same read cannot resolve an unchanged non-retryable access contract failure.

`completion-recovery-v6` retains history-tagged answer text separately after the business prompt starts, bounded to 512 KiB across transports. Only replay independently matched to the original provider turn is exposed. GET/POST replay snapshots are compared rather than concatenated: a replay replaces live text only if it contains all accepted live bytes; conflicting representations remain readable separately. Unmatched session history is not attached to the task.

Task metadata and the final result artifact include `outputIntegrity:{completeness,sizeBytes,sha256,truncated}`. `completeness` is stream_complete only for an ended correlated received stream without known loss or ambiguity; otherwise it is unverified, or partial when capture/provider limits are known. A large history-frame count alone proves neither truncation nor an old turn. Old diagnostics that record discarded history leave completeness unverified; an upgrade cannot reconstruct dropped frames. `completionVerified` certifies the authoritative turn-ending signal, separately from body delivery. The hash and byte length describe exactly the delivered UTF-8 bytes, not an unseen provider/UI answer. Compare them with independently supplied expected values when exact content is required.


`completion-recovery-v7` includes outputIntegrity on every delivered inline text artifact: unverified live candidates, correlated replay, inline provider text and the final result/notice. Each digest/length covers only that artifact's own UTF-8 text. A completed cloud turn lacking correlated Answer is named WorkBuddy completion notice with contentRole=execution_notice, rather than suggesting the notice is the answer. Unverified candidates keep completeness=unverified unless actual capture limits require partial. Requested length, frame count or a large transport payload is not an independent proof of provider output length.

Diagnostics add execution.updates (fixed protocol variant labels; frames, textBlocks, textBytes, untypedTextBytes, contentShapes, channels) and lastResponse.hasProviderId. Text counts follow ContentBlock/ToolCallContent wrappers; raw metadata, commands and tool rawInput/rawOutput are not counted as answer text. This distinguishes 42 answer chunks from many tool/thought/state updates without exposing their content. Old traces without updates cannot retrospectively supply the breakdown. The receiver exposes independently matched replay in artifacts/.../correlated-replay, not a GetTask.history array. No history counter and no bound providerRequestId are not evidence that hidden original-turn history was retained and withheld.
