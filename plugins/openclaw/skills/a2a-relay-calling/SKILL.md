---
name: a2a-relay-calling
description: Coordinate authorized remote A2A tasks with the current OpenClaw Connector identity or Relay MCP tools, recover owned results, and deliver files using native A2A or Relay temporary fallback.
---

Relay uses organization authorization as its only runtime. Manage identities and grants in `/console`; there is no global pairing approval or shared administrator/client token authentication.


Use this skill for remote Relay task coordination and related permission/recovery diagnosis. Installing the Connector provides an inbound tunnel and its management tools; pairing does not register remote dispatch tools or grant access to another Agent.

## Select the actual client and identity

Inspect the tools available in the current Agent session. Prefer actual Relay MCP tools such as a2a_targets, a2a_send, a2a_task and a2a_request when present, following their schemas. The send tool accepts targetAgentId, a stable messageId and text, and builds the wire message. Its MCP Controller may differ from the Connector identity, even when display names match.

OpenClaw's native A2A channel is the local receiving service. Its configured peers and tools do not automatically use Relay credentials or target permissions. Missing outbound tools do not imply Relay is offline. Do not invent tool names, enable another channel, restart Gateway, install a second Connector or switch credentials to work around a denial. If no suitable client tool exists, use the authenticated HTTPS protocol in [references/relay-http.md](references/relay-http.md); read it before constructing requests.

Use the current Gateway profile's a2a-connector plugin configuration for the Relay URL and explicit state path. The plugin's default credential path is ~/.config/a2a-connector/openclaw.json; independent instances should have separate configured paths. a2a_connector_status reports inbound Connector health, not whether remote task dispatch is authorized. Read the credential only inside the HTTP client process. Never print it, interpolate it into shell arguments, put it in task text, or forward it to a different origin on redirect. Reuse the existing identity instead of re-pairing for ordinary calls.

## Enterprise permissions

Read GET /pairing/targets and retain callerAgentId. Choose an exact authorized target ID and inspect its Agent Card. Check exact IDs instead of names, and distinguish discovery, invocation and task access.

The enterprise administrator grants access in /console → Agent 管理 → the **target's** 谁能访问 (older UI: 授权) → 机器调用方 → this caller. The direction is **caller → target**. Choosing the target on the caller's row grants the reverse direction. Enrollment uses the identity-bound one-time ticket from 接入 Agent → Connector. User groups govern use permissions, not the enrollment approver.

discover reads a card; invoke sends; task_read reads an owned task. Cancellation, permission decisions and tracking release require their respective actions. Personal callers additionally need the bound member's effective direct/group permissions intersected with machine grants; service callers use explicit machine grants. The credential needs call scope, the caller must be active/canCall and the target active/canReceive. Administrator status does not bypass task permissions.

## Send once, recover, then read the result

Perform the user's requested delegation without duplicate permission questions. A connection inspection alone does not authorize sending a real test task. Before dispatch, retain the exact target, instruction, execution mode, unique stable messageId and preallocated 32-character lowercase hexadecimal Relay request ID in a private local record.

For HTTP SendMessage, use the guide's complete JSON-RPC envelope: params.message.role is exactly ROLE_USER, params.message.messageId is nonempty and unique, and params.message.parts contains text objects. Bare text, role: user, and JSON-RPC id alone are insufficient. Use JSON encoding instead of shell interpolation, and do not enable automatic POST retries. WorkBuddy execution mode belongs in message.metadata.workbuddyMode as cloud or desktop, only as supported by the target.

Save the returned A2A task ID and context ID. Read GetTask with params.id using the same target and caller credential. Relay requires task_read and ownership by that exact identity; a random UUID or a task from an older identity is not a permission test. ListTasks/tasks/list now returns only this caller's owned tasks with task_read. Use the shared guide's filters and Relay page tokens; never switch identity or infer non-execution from an empty list. Older Relay versions require upgrading, not extra invoke grants.

After timeout or disconnect, query GET /relay/requests/<original-relay-request-id> with the same identity before considering any resend. Relay supports this durable journal. A receipt 404 may mean no reservation, expiry, wrong caller or revoked access; it does not prove non-execution. X-Relay-Request-Id alone does not create a reservation without a recognized messageId or Idempotency-Key. JSON-RPC id, messageId, Relay request ID and task ID are distinct handles.

Keep original IDs and content during uncertain outcomes; do not create a new instruction merely to retry. For a new follow-up after completion, use a new messageId and the returned contextId only if that target supports it. Hosted WorkBuddy rejects overlapping unresolved work and supplied taskId continuation. Do not assume every native receiver extension is exposed by Relay; use the guide's allowlist and recovery rules.

## Retrieve delivered files

Prefer actual native file bytes or a verified caller-accessible native URL. When only a local file path remains, use [the generic Relay fallback](references/relay-http.md#native-file-delivery-and-generic-relay-fallback), advertised by health `artifactTransferVersion: relay-temp-v1` or card `relayArtifactTransferVersion`. For a resolved task, a transfer-only follow-up can ask the same receiving Agent to upload the exact already generated file into the original task, using the supported context and a new stable message ID. The receiver uses its own installed Connector helper/private state; do not provide caller credentials or repeat the business work. Recover uncertain sends before any follow-up. As a receiver, upload only an explicitly selected authorized deliverable with the guide's CLI command; do not scrape paths from arbitrary text. If the helper/file is unavailable, report it.

For hosted cloud targets advertising `artifactTransferVersion: relay-temp-v1`, Relay supplies the executing sandbox with private upload instructions. State the user's required file deliverables in the business request; do not construct an upload token, request ACP/envd credentials, or send file bytes through the answer text.

Read the original task's `artifacts` as soon as files are registered. Preserve the exact `artifactId`, target and task ID. `metadata.downloadSource: relay_temp` with `transferStatus: ready` means a staged file is available until `expiresAt`, normally one hour after upload. Download promptly even if the task is still working or its final answer is missing; file availability and business completion are separate. An `agent:///` URI is an artifact identifier, not an HTTP download URL.

Use the same caller identity that created the task. If that task was created by the current Relay MCP Controller and `a2a_artifact` is registered, call `a2a_artifact({targetAgentId, taskId, artifactId})` (512 KiB limit). For a task created with Connector credentials, follow [the registered-file download procedure](references/relay-http.md#download-a-registered-workbuddy-file): call `GetArtifact` with `params: {id: originalTaskId, artifactId, maxBytes: 8388608}` using the original Connector credentials. Decode `parts[].raw`, verify `sizeBytes` and SHA-256 against the task's recorded file metadata, and save to an explicit local path. Never switch between MCP and Connector identities to work around a limit/denial. If the current session has no suitable authorized download client, report that limitation instead of inventing a tool or a public URL.

A file reference or the agent's statement that it created/uploaded a file is not proof of delivery. Verify the downloaded bytes and the requested deliverable. On `relay_artifact_expired_or_missing`, `relay_artifact_integrity_failed` or `retryable:false`, report the exact blocker; do not repeatedly poll unchanged reads, release tracking or resend business work. Download retries do not extend retention. Automatic sandbox upload instructions apply to new hosted WorkBuddy cloud turns; the generic Connector helper above is an explicit receiving-side fallback.

## Interpret and report evidence

A readable card checks discovery, not every task action. JSON-RPC -32602 is parameter validation, not a Relay ACL denial. GetTask 403 can mean missing task_read or wrong ownership, without proving whether SendMessage is allowed. An empty targetAgentId in an older error is a diagnostic omission, not proof that the target was untouched. Use the guide's error table and report actual caller/target IDs and operation-specific evidence.

Distinguish rejected, submitted, working, input-required, completed, failed, canceled and unknown. A completed Relay receipt means one HTTP exchange completed; inspect responseBody and the actual task result before claiming end-to-end execution succeeded. Show permission details for a human decision; cancel or release only within the user's instructions. Releasing tracking does not cancel remote execution or prove completion. Hosted cloud execution does not require the user's PC online; desktop execution needs the correct receiving account and PC remote-control permission. Receiving-side setup failures do not mean the caller should redo OAuth.
