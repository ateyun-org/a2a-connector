---
name: a2a-relay-calling
description: Delegate authorized A2A tasks with DSH tools, recover uncertain dispatches without resending, and deliver files through native A2A or the receiving Connector Relay fallback.
---

Relay uses organization authorization as its only runtime. Manage identities and grants in `/console`; there is no global pairing approval or shared administrator/client token authentication.


The DSH plugin supplies native tools when agents are configured. Their descriptions contain the core enterprise rules; this packaged skill supplies the full workflow. This package does not declare a host skill auto-loader. Load this file through the actual host's file/context mechanism when more detail is needed. Do not assume a skill file alone registers a tool.

## Use the DSH tool schemas

- a2a_agents() inspects configured aliases and live cards. Choose the configured agent_id by purpose and verify the exact target Agent ID in its card URL; the alias is not necessarily the Relay ID. Card availability does not prove invoke or task_read permission.
- a2a_send({agent_id, message, message_id?, conversation_id?}) sends the user's authorized text. The client generates ROLE_USER, messageId and text parts, persists the dispatch before sending and returns local conversationId plus remote taskId/contextId and relayRequestId. Do not pass MCP-style targetAgentId/text fields to this DSH tool. Retain a supplied message_id for that exact instruction. Connection checks alone do not authorize a real test task.
- a2a_task({conversation_id}) reads the task mapped by the local conversation. The current DSH session must own the conversation; Relay independently checks task_read and the original caller Agent's task ownership.
- a2a_conversations({include_previous_sessions?}) lists local records, not a remote task collection. Cross-session history requires the explicit read-only flag; it does not transfer ownership for follow-up or cancellation.
- a2a_reconcile({conversation_id, include_previous_sessions?}) recovers the original receipt or task without another send. This is client-side recovery and does not call the remote ReconcileCloudTask extension. After timeout, disconnection or unknown outcome, use this tool and retain every original ID. Receipt 404 does not prove non-execution or disabled journaling. Relay recovery does not fall back to ListTasks.
- a2a_cancel({conversation_id}) requests cancellation only within the user's instructions. A request is not proof of remote cancellation; keep tracking the actual result. Desktop WorkBuddy may report cancellation unsupported.

Missing tools can mean agents were not configured in the actual DSH profile. Do not invent tools, install another SDK copy or change the profile without authorization. Read the package's install guide and actual config first. If a direct HTTPS client is needed, use [the shipped protocol reference](references/relay-http.md), not a guessed request format. Never expose tokens in task text, output, URLs or shell arguments.

## Enterprise identity and permission

Relay credentials come from the same configured Connector state (connectorState may select an explicit path). Do not switch credentials or re-enroll to work around denial. An MCP Controller and a Connector can have different identities despite identical names. When querying /pairing/targets, record callerAgentId and exact target IDs.

Enrollment uses the one-time identity-bound ticket from /console → Agent 管理 → 接入 Agent → Connector. For access grants, open the **target's** 谁能访问 (older UI: 授权), choose this DSH identity as 机器调用方 and grant caller → target. Personal callers need machine grants intersected with bound member direct/group grants; service callers use explicit machine grants. Credential call scope and active/canCall status also matter; administrator status is not a task-permission bypass.

discover reads cards; invoke sends; task_read reads owned tasks. Other actions have their own grants. A random task ID or old caller's task is not a valid invoke probe. GetTask denial can mean wrong ownership; SendMessage -32602 means parameter validation. ListTasks/tasks/list supports only the current caller's owned tasks with task_read. Raw HTTP listing uses the shared guide and five-minute Relay page tokens; local a2a_task continues using its session-owned conversation mapping. Listing cannot replace the original receipt/task when recovering an uncertain send.

## Retrieve delivered files

Prefer actual native file bytes or a verified caller-accessible native URL. When only a local file path remains, use [the generic Relay fallback](references/relay-http.md#native-file-delivery-and-generic-relay-fallback), advertised by health `artifactTransferVersion: relay-temp-v1` or card `relayArtifactTransferVersion`. For a resolved task, a transfer-only follow-up can ask the same receiving Agent to upload the exact already generated file into the original task, using the supported context and a new stable message ID. The receiver uses its own installed Connector helper/private state; do not provide caller credentials or repeat the business work. Recover uncertain sends before any follow-up. As a receiver, upload only an explicitly selected authorized deliverable with the guide's CLI command; do not scrape paths from arbitrary text. If the helper/file is unavailable, report it.

For hosted cloud targets advertising `artifactTransferVersion: relay-temp-v1`, Relay supplies the executing sandbox with private upload instructions. State the user's required file deliverables in the business request; do not construct an upload token, request ACP/envd credentials, or send file bytes through the answer text.

Use `a2a_task({conversation_id})` to inspect the original task's `artifacts` as soon as files are registered; retain its remote task ID separately from the local conversation ID. Preserve the exact `artifactId`, target and task ID. `metadata.downloadSource: relay_temp` with `transferStatus: ready` means a staged file is available until `expiresAt`, normally one hour after upload. Download promptly even if the task is still working or its final answer is missing; file availability and business completion are separate. An `agent:///` URI is an artifact identifier, not an HTTP download URL.

Use the same caller identity that created the task. If that task was created by the current Relay MCP Controller and `a2a_artifact` is registered, call `a2a_artifact({targetAgentId, taskId, artifactId})` (512 KiB limit). DSH does not currently register a native artifact-download tool. For a DSH Connector-owned task, follow [the registered-file download procedure](references/relay-http.md#download-a-registered-workbuddy-file): call `GetArtifact` with `params: {id: originalTaskId, artifactId, maxBytes: 8388608}` using the original Connector credentials. Decode `parts[].raw`, verify `sizeBytes` and SHA-256 against the task's recorded file metadata, and save to an explicit local path. Never switch between MCP and Connector identities to work around a limit/denial. If the current session has no suitable authorized download client, report that limitation instead of inventing a tool or a public URL.

A file reference or the agent's statement that it created/uploaded a file is not proof of delivery. Verify the downloaded bytes and the requested deliverable. On `relay_artifact_expired_or_missing`, `relay_artifact_integrity_failed` or `retryable:false`, report the exact blocker; do not repeatedly poll unchanged reads, release tracking or resend business work. Download retries do not extend retention. Automatic sandbox upload instructions apply to new hosted WorkBuddy cloud turns; the generic Connector helper above is an explicit receiving-side fallback.

## Completion and recovery

Use conversation_id for an intentional follow-up after completion, with a new message_id for the new instruction. Keep IDs/content unchanged during uncertain outcomes; never create a new instruction merely because a response timed out. JSON-RPC id, messageId, local conversationId, relayRequestId, remote taskId and contextId are separate handles. Completed receipts describe an HTTP exchange; inspect the actual task state/output before claiming the user's task completed.

Report rejected, submitted, working, input-required, completed, failed, canceled and unknown accurately. Do not free an unresolved queue by auto-releasing tracking. Show permission requests for the human's actual decision. Hosted cloud execution does not require the user's desktop online; desktop execution needs the correct receiving account and PC remote-control permission. A receiving-side authorization error is not a request to redo caller OAuth.
