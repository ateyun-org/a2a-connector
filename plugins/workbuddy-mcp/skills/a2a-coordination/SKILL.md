---
name: a2a-coordination
description: Use the current Chuanbota MCP connection to discover authorized Agents, delegate A2A tasks, recover durable requests and retrieve results or delivered files.
---

Use the tools registered by the current MCP connection. Manage Controller identity and target permissions in `/console`. Buddy application modes and capsules are task presets; they do not establish connections or grant access.

## Connection

Connect through WorkBuddy's MCP connection flow. The user logs into Relay, selects an enterprise they belong to, and confirms OAuth consent; Relay creates/reuses the personal MCP Controller for that member. Identify the current Controller by its exact Agent ID when checking permissions; a display name alone does not identify the caller.

Enterprise grants are configured at `/console` → Agent 管理 → the **target's** 谁能访问 (older UI: 授权) → 机器调用方 → this exact MCP Controller. The direction is caller → target. `discover` reads the card, `invoke` sends, `task_read` reads owned tasks; cancel/permission/release have separate actions. A personal MCP Controller needs explicit machine grants intersected with its bound member's effective direct/group grants. Service Controllers use machine grants. Administrator status does not bypass task permissions. Permission changes belong to the administrator in the console; no administrator tool is exposed.

The MCP connection handles its OAuth credentials. Use its registered tools for discovery, dispatch and task reads. Never request private tokens or secrets in prompts, tool arguments or output. Completing OAuth still requires explicit target permissions before tasks can be called.

## Tools

1. `a2a_targets`: list exact discoverable Agent IDs and receiving connection state. If empty, check the actual Controller/enterprise, discovery grants, active target state and personal member intersection. Discovery does not establish invoke/task_read permission. Hosted readiness does not prove the execution PC is online.
2. `a2a_agent(targetAgentId)`: inspect the live Agent Card and its real skills before delegation.
3. `a2a_send(targetAgentId, messageId, text, contextId?, taskId?)`: send the user's authorized instruction once. Choose a unique stable messageId and retain it for that exact instruction. The tool constructs `params.message` with wire role `ROLE_USER`, `messageId` and `parts: [{"text": ...}]`; do not replace it with guessed raw HTTP. Use the original contextId for an intentional follow-up and a new messageId for the new instruction. Include taskId only if that target supports continuing the original input-required task; hosted WorkBuddy does not. A duplicate ID with changed content is invalid. A request to inspect connectivity does not itself authorize sending a real test task.
4. `a2a_request(relayRequestId)`: recover the original durable receipt after timeout/disconnection. A completed Relay receipt means the original HTTP response arrived; inspect its responseBody to determine whether the remote task itself completed. A submitted or working task is not a completed user objective.
5. `a2a_task(targetAgentId, taskId)`: query a task created by this same caller for state, text, artifacts and permission metadata. Enterprise mode checks task_read and stable task ownership; random task IDs or an old identity's task are not a valid permission probe.
6. `a2a_cancel(targetAgentId, taskId)`: request cancellation when asked. Query afterwards until the actual canceled state arrives. Desktop localassistant targets may explicitly report cancellation unsupported.
7. `a2a_permission(targetAgentId, taskId, requestId, optionId)`: only after the human explicitly chooses an option, send that exact original optionId and preserve requestId's string/number type. Show the actual tool details and options first. Never select an approval merely to continue execution.
8. `a2a_release(targetAgentId, taskId, cloudTaskId?)`: only when the human explicitly asks to abandon unresolved tracking. The target requires an inactive cloud session and verifies recovered creation IDs by their original cloudName. This marks tracking rejected/unverified, not remotely canceled or successfully completed. Never release an unknown task automatically to free a queue.

## Retrieve delivered files

Prefer native file bytes or a verified caller-accessible URL. If a target returned only a local path and advertises file delivery through Relay health `artifactTransferVersion: relay-temp-v1` or card `relayArtifactTransferVersion`, the user-authorized delivery can require a separate transfer-only follow-up to that same Agent. Supply the original task ID and exact existing deliverable path, use the supported context and a new stable message ID, and ask the receiving Agent to deliver that existing file through its advertised capability. The receiving Agent handles the transfer with its own authorization. Recover an uncertain original send first; never repeat the business work or supply this Controller's credentials. After registration, read the original task and use its exact artifact ID with this same Controller. If the receiver cannot deliver the file or the file is gone, report it.

When the target card advertises `artifactTransferVersion: relay-temp-v1`, new hosted cloud turns receive file-delivery instructions automatically. Request the user's required deliverable files in the task text; the receiving Agent handles delivery. Never invent an upload token or ask for the target's private credentials.

Inspect the original task with `a2a_task`. For each file in `artifacts`, retain its exact `artifactId`. `metadata.downloadSource: relay_temp`, `transferStatus: ready` and `expiresAt` identify temporary file delivery, normally retained for one hour after upload. Download promptly even before task completion or when the final answer is absent. An `agent:///` identifier is not a public URL.

If registered in this session, call `a2a_artifact({targetAgentId, taskId, artifactId})` with the original target and task ID. It uses this MCP Controller's original task ownership and `task_read`, returns UTF-8 text or Base64 raw bytes with size/SHA-256, and is limited to 512 KiB. Verify against the task's recorded file metadata and inspect the requested deliverable before reporting successful file delivery. This does not prove business completion. If the file exceeds the tool limit or the tool is unavailable, report the concrete limitation and keep the original Controller identity; another caller's `task_read` does not transfer task ownership. Do not guess an HTTP URL or request private OAuth tokens.

On `relay_artifact_expired_or_missing`, `relay_artifact_integrity_failed` or `retryable:false`, report the blocker without resending the business task, releasing tracking or repeatedly polling unchanged reads. Download retries do not extend retention. File-delivery capabilities vary by target and execution mode; use only what the target advertises.

## Results and recovery

Persist/report the returned relayRequestId, task ID and context ID. A Relay timeout or pending/unknown receipt does not prove non-execution. Query `a2a_request` before any retry; missing/expired journal evidence also does not permit resending under a new messageId. The Relay deduplicates the original stable messageId within its retention window. Do not claim a task is safe to repeat merely because a connection failed.

Relay supports durable receipts. A receipt 404 can mean wrong caller, expired/no reservation or revoked target access; never conclude that enterprise journaling is disabled. JSON-RPC id is response correlation, messageId is instruction identity, relayRequestId identifies the receipt, and taskId identifies the target task; keep them separate. Receipt completion does not establish task completion.

`a2a_tasks({targetAgentId, pageSize?, pageToken?, contextId?, status?})` lists only this caller's tasks with task_read. Optional historyLength and includeArtifacts control content. Keep identical options and caller/target with the returned nextPageToken; pages expire after five minutes and live grants are rechecked. An empty list does not prove an uncertain send did not execute. Older Relay versions need upgrading if listing returns501. GetTask 403 can mean missing task_read or wrong ownership. JSON-RPC -32602 means invalid request parameters, not an ACL failure; only an explicit rejection before task creation establishes that the malformed request created no task. Tool registration and a readable card also do not prove all task operations are allowed.

Respect task states: submitted/working continue tracking; input-required needs user input or inspection; completed requires the target's actual completion signal; failed/rejected/canceled are not success. Return verified output and available artifact locations. `agent:///` locations belong to the cloud sandbox and are not automatically public download URLs.

## Target availability

The target owner manages its account authorization and execution readiness in the Relay console. Use the target's live capabilities and returned task state to explain any blocker.

If a task reports `workbuddy_not_authorized`, ask the target owner to complete that target's WorkBuddy account authorization in the console. The current Controller's MCP OAuth only authorizes the caller. If it reports `blockedReason=workbuddy_channel_not_configured`, show the target's rejection state and ask its owner to enable 连接移动端 → 小程序 → 允许移动端连接此设备 on the execution PC. PC online status alone does not verify this permission. A cloud target does not require that desktop switch. Do not automatically change remote-access settings, keep polling a terminal rejection or resend the task.
