---
name: a2a-relay-calling
description: Discover authorized remote Agents, delegate A2A tasks through Relay, and recover owned tasks and durable receipts using the current OpenClaw Connector identity or available Relay MCP tools.
---

Use this skill for remote Relay task coordination and related permission/recovery diagnosis. Installing the Connector provides an inbound tunnel and its management tools; pairing does not register remote dispatch tools or grant access to another Agent.

## Select the actual client and identity

Inspect the tools available in the current Agent session. Prefer actual Relay MCP tools such as a2a_targets, a2a_send, a2a_task and a2a_request when present, following their schemas. The send tool accepts targetAgentId, a stable messageId and text, and builds the wire message. Its MCP Controller may differ from the Connector identity, even when display names match.

OpenClaw's native A2A channel is the local receiving service. Its configured peers and tools do not automatically use Relay credentials or target permissions. Missing outbound tools do not imply Relay is offline. Do not invent tool names, enable another channel, restart Gateway, install a second Connector or switch credentials to work around a denial. If no suitable client tool exists, use the authenticated HTTPS protocol in [references/relay-http.md](references/relay-http.md); read it before constructing requests.

Use the current Gateway profile's a2a-connector plugin configuration for the Relay URL and explicit state path. The plugin's default credential path is ~/.config/a2a-connector/openclaw.json; independent instances should have separate configured paths. a2a_connector_status reports inbound Connector health, not whether remote task dispatch is authorized. Read the credential only inside the HTTP client process. Never print it, interpolate it into shell arguments, put it in task text, or forward it to a different origin on redirect. Reuse the existing identity instead of re-pairing for ordinary calls.

## Enterprise permissions

Read GET /pairing/targets and retain callerAgentId. Choose an exact authorized target ID and inspect its Agent Card. Check exact IDs instead of names, and distinguish discovery, invocation and task access.

The enterprise administrator grants access in /console → Agent 管理 → the **target's** 谁能访问 (older UI: 授权) → 机器调用方 → this caller. The direction is **caller → target**. Choosing the target on the caller's row grants the reverse direction. Enterprise enrollment uses the identity-bound one-time ticket from 接入 Agent → Connector; the confirmation-code /pair/list workflow applies only to legacy Redis-only deployments. User groups govern use permissions, not the enrollment approver.

discover reads a card; invoke sends; task_read reads an owned task. Cancellation, permission decisions and tracking release require their respective actions. Personal callers additionally need the bound member's effective direct/group permissions intersected with machine grants; service callers use explicit machine grants. The credential needs call scope, the caller must be active/canCall and the target active/canReceive. Administrator status does not bypass task permissions.

## Send once, recover, then read the result

Perform the user's requested delegation without duplicate permission questions. A connection inspection alone does not authorize sending a real test task. Before dispatch, retain the exact target, instruction, execution mode, unique stable messageId and preallocated 32-character lowercase hexadecimal Relay request ID in a private local record.

For HTTP SendMessage, use the guide's complete JSON-RPC envelope: params.message.role is exactly ROLE_USER, params.message.messageId is nonempty and unique, and params.message.parts contains text objects. Bare text, role: user, and JSON-RPC id alone are insufficient. Use JSON encoding instead of shell interpolation, and do not enable automatic POST retries. WorkBuddy execution mode belongs in message.metadata.workbuddyMode as cloud or desktop, only as supported by the target.

Save the returned A2A task ID and context ID. Read GetTask with params.id using the same target and caller credential. Enterprise mode requires task_read and ownership by that exact identity; a random UUID or a task from an older identity is not a permission test. ListTasks/tasks/list is unsupported through enterprise Relay (501 rpc_method_not_supported; older versions returned 403), even when the local receiver implements it. Do not ask for another invoke grant because listing failed.

After timeout or disconnect, query GET /relay/requests/<original-relay-request-id> with the same identity before considering any resend. Enterprise Relay supports this durable journal. A receipt 404 may mean no reservation, expiry, wrong caller or revoked access; it does not prove non-execution. X-Relay-Request-Id alone does not create a reservation without a recognized messageId or Idempotency-Key. JSON-RPC id, messageId, Relay request ID and task ID are distinct handles.

Keep original IDs and content during uncertain outcomes; do not create a new instruction merely to retry. For a new follow-up after completion, use a new messageId and the returned contextId only if that target supports it. Hosted WorkBuddy rejects overlapping unresolved work and supplied taskId continuation. Do not assume every native receiver extension is exposed by enterprise Relay; use the guide's allowlist and recovery rules.

## Interpret and report evidence

A readable card checks discovery, not every task action. JSON-RPC -32602 is parameter validation, not a Relay ACL denial. GetTask 403 can mean missing task_read or wrong ownership, without proving whether SendMessage is allowed. An empty targetAgentId in an older error is a diagnostic omission, not proof that the target was untouched. Use the guide's error table and report actual caller/target IDs and operation-specific evidence.

Distinguish rejected, submitted, working, input-required, completed, failed, canceled and unknown. A completed Relay receipt means one HTTP exchange completed; inspect responseBody and the actual task result before claiming end-to-end execution succeeded. Show permission details for a human decision; cancel or release only within the user's instructions. Releasing tracking does not cancel remote execution or prove completion. Hosted cloud execution does not require the user's PC online; desktop execution needs the correct receiving account and PC remote-control permission. Receiving-side setup failures do not mean the caller should redo OAuth.
