---
name: relay-calling
description: Coordinate authorized remote A2A tasks with the current Hermes identity, recover owned results, and deliver files using native A2A or Relay temporary fallback, including receiving-side file uploads.
---

Relay uses organization authorization as its only runtime. Manage identities and grants in `/console`; there is no global pairing approval or shared administrator/client token authentication.


Use the existing Relay identity and user-authorized task. Connector pairing/tunnel tools manage inbound connectivity; they do not themselves register outbound A2A tools or grant access to another Agent.

## Choose the available client

Inspect the tools actually registered in this Hermes session. If Relay MCP tools such as `a2a_targets`, `a2a_send`, `a2a_task`, and `a2a_request` are present, use their schemas: `a2a_send` constructs the protocol message from `targetAgentId`, a stable `messageId`, and `text`. An MCP Controller may have a different Agent ID from this Connector.

Hermes' bundled A2A platform tools may be absent when that platform is disabled. `tool_describe` returning `not_found` proves the tool is unavailable, not that Relay is offline. Do not invent tools, silently edit Hermes configuration, restart Gateway, or create another identity to work around this. For the existing Connector identity, use authenticated HTTPS requests following [the HTTP protocol guide](references/relay-http.md). Read that guide before constructing an HTTP request.

`a2a_connector_status` and `/a2a_connector doctor` identify the active Connector state path without exposing credentials. Resolve the actual profile, non-secret Relay configuration and private state file; read its token only inside the HTTP client process. Never print credentials or put them in shell arguments, URLs, logs, or task text. Reuse the existing identity; do not re-pair for ordinary calls.

## Discover and verify permission direction

1. Read `GET /pairing/targets`. Record the returned `callerAgentId`; compare exact IDs with the intended Controller, rather than relying on names.
2. Choose an exact returned target ID and read its advertised Agent Card. An empty list, a failed card read, and an unsupported RPC method require different diagnoses.
3. the administrator opens the **target's** row at `/console` → Agent 管理 → 谁能访问 (older UI: 授权), chooses this identity as 机器调用方, and grants the needed actions. The direction is **caller → target**. Configuring the caller's row with the target selected grants the reverse direction.

Permissions: `discover` reads the card; `invoke` sends a task; `task_read` reads an owned task. Other operations require their corresponding actions. Personal Controllers additionally require the bound member's effective direct/group permissions; service Controllers use explicit machine grants. Credential scope `call` and Agent capability `canCall` are also required. Administrator status does not bypass these checks. User groups control use permissions, not who approves Connector enrollment.

## Dispatch and track

Send only the user's requested work; connection inspection does not authorize a real test task. If a user has already requested delegation, carry it out without asking for duplicate approval. Before a send, retain the exact target, text, mode, unique stable `messageId`, and a preallocated 32-character lowercase hexadecimal Relay request ID in a private local record.

For direct HTTP, use the exact `params.message` envelope, `role: "ROLE_USER"`, a nonempty unique `messageId`, and `parts: [{"text": "..."}]` from the guide. A bare `text`, `role: "user"`, or JSON-RPC `id` alone is insufficient. Keep the same payload and IDs for any explicitly justified exact retry; never change IDs merely because an outcome is uncertain.

Save the returned A2A task ID and context ID. Query `GetTask` using `params.id` and the same caller credentials. Relay requires both `task_read` and ownership by this caller; random IDs or tasks created by another/old identity cannot test access. Use ListTasks/tasks/list to enumerate only tasks durably owned by this caller, with task_read. Follow the HTTP guide for filters and five-minute Relay pagination. An empty list is not an invoke/readiness test or proof of non-execution.

After timeout/disconnection, recover `GET /relay/requests/<original-relay-request-id>` with the same identity before any resend. Relay supports this journal. A 404 can mean no reservation, expiry, wrong caller, or revoked access; it is not proof of non-execution. Read the guide's ID and error tables instead of inferring global capabilities from one response.

For an intentional follow-up after completion, use a new message ID and the returned context ID only if that target supports it. Hosted WorkBuddy rejects overlapping unresolved work and does not accept continuing via an arbitrary `taskId`. Choose `message.metadata.workbuddyMode: cloud|desktop` only as advertised; preserve the mode across exact retries and existing contexts.

## Retrieve delivered files

Prefer actual native file bytes or a verified caller-accessible native URL. When only a local file path remains, use [the generic Relay fallback](references/relay-http.md#native-file-delivery-and-generic-relay-fallback), advertised by health `artifactTransferVersion: relay-temp-v1` or card `relayArtifactTransferVersion`. For a resolved task, a transfer-only follow-up can ask the same receiving Agent to upload the exact already generated file into the original task, using the supported context and a new stable message ID. The receiver uses its own installed Connector helper/private state; do not provide caller credentials or repeat the business work. Recover uncertain sends before any follow-up. As a receiver, upload only an explicitly selected authorized deliverable with the guide's CLI command; do not scrape paths from arbitrary text. If the helper/file is unavailable, report it.

For hosted cloud targets advertising `artifactTransferVersion: relay-temp-v1`, Relay supplies the executing sandbox with private upload instructions. State the user's required file deliverables in the business request; do not construct an upload token, request ACP/envd credentials, or send file bytes through the answer text.

Read the original task's `artifacts` as soon as files are registered. Preserve the exact `artifactId`, target and task ID. `metadata.downloadSource: relay_temp` with `transferStatus: ready` means a staged file is available until `expiresAt`, normally one hour after upload. Download promptly even if the task is still working or its final answer is missing; file availability and business completion are separate. An `agent:///` URI is an artifact identifier, not an HTTP download URL.

Use the same caller identity that created the task. If that task was created by the current Relay MCP Controller and `a2a_artifact` is registered, call `a2a_artifact({targetAgentId, taskId, artifactId})` (512 KiB limit). For a task created with Connector credentials, follow [the registered-file download procedure](references/relay-http.md#download-a-registered-workbuddy-file): call `GetArtifact` with `params: {id: originalTaskId, artifactId, maxBytes: 8388608}` using the original Connector credentials. Decode `parts[].raw`, verify `sizeBytes` and SHA-256 against the task's recorded file metadata, and save to an explicit local path. Never switch between MCP and Connector identities to work around a limit/denial. If the current session has no suitable authorized download client, report that limitation instead of inventing a tool or a public URL.

A file reference or the agent's statement that it created/uploaded a file is not proof of delivery. Verify the downloaded bytes and the requested deliverable. On `relay_artifact_expired_or_missing`, `relay_artifact_integrity_failed` or `retryable:false`, report the exact blocker; do not repeatedly poll unchanged reads, release tracking or resend business work. Download retries do not extend retention. Automatic sandbox upload instructions apply to new hosted WorkBuddy cloud turns; the generic Connector helper above is an explicit receiving-side fallback.

## Report the actual outcome

Distinguish permission checked, request rejected, task submitted, working, input-required, completed, failed, canceled, and unknown. A JSON-RPC validation error is not an authorization denial. A completed Relay receipt describes one HTTP exchange; inspect its response body for the remote task state. Do not claim end-to-end execution succeeded until the actual task returns verified completion and output.

Show permission requests and let the user choose the exact option; cancel/release only within the user's instructions. Releasing tracking is not remote cancellation or successful completion. Cloud targets do not require the execution PC online; desktop targets need the correct receiving account, running PC app, and its remote-control permission. Prefer the target's actual setup error over asking the caller to repeat OAuth.
