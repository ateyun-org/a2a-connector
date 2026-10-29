---
name: a2a-coordination
description: Use Chuanbota's OAuth-protected MCP tools to delegate authorized A2A tasks, track durable requests and retrieve results.
---

Relay uses organization authorization as its only runtime. Manage identities and grants in `/console`; there is no global pairing approval or shared administrator/client token authentication.


The connector supplies actual remote MCP tools. Buddy application modes and capsules are task presets; they do not establish connections or grant access.

## Connection

Use WorkBuddy's connector connection flow. OAuth discovers the Relay's metadata, registers a public client and uses PKCE. the user logs into Relay, selects an enterprise they belong to, and confirms consent; Relay creates/reuses the personal MCP Controller for that member. This Controller can differ from an existing Connector identity with the same display name. Inspect exact IDs before diagnosing grants.

Enterprise grants are configured at `/console` → Agent 管理 → the **target's** 谁能访问 (older UI: 授权) → 机器调用方 → this exact MCP Controller. The direction is caller → target. `discover` reads the card, `invoke` sends, `task_read` reads owned tasks; cancel/permission/release have separate actions. A personal MCP Controller needs explicit machine grants intersected with its bound member's effective direct/group grants. Service Controllers use machine grants. Administrator status does not bypass task permissions. Do not automatically approve pairing, grant targets, select wildcard access or handle administrator credentials with model tools. No administrator tool is exposed.

The connector uses its own OAuth tokens. They are distinct from the Buddy application's Client Secret and from upstream WorkBuddy Open API/ACP tokens. Never ask for or include those secrets in prompts, tool arguments or output. User pairing approvals and target grants remain mandatory even after installing the connector.

## Tools

1. `a2a_targets`: list exact discoverable Agent IDs and receiving connection state. If empty, check the actual Controller/enterprise, discovery grants, active target state and personal member intersection. Discovery does not establish invoke/task_read permission. Hosted readiness does not prove the execution PC is online.
2. `a2a_agent(targetAgentId)`: inspect the live Agent Card and its real skills before delegation.
3. `a2a_send(targetAgentId, messageId, text, contextId?, taskId?)`: send the user's authorized instruction once. Choose a unique stable messageId and retain it for that exact instruction. The tool constructs `params.message` with wire role `ROLE_USER`, `messageId` and `parts: [{"text": ...}]`; do not replace it with guessed raw HTTP. Use the original contextId for an intentional follow-up and a new messageId for the new instruction. Include taskId only if that target supports continuing the original input-required task; hosted WorkBuddy does not. A duplicate ID with changed content is invalid. A request to inspect connectivity does not itself authorize sending a real test task.
4. `a2a_request(relayRequestId)`: recover the original durable receipt after timeout/disconnection. A completed Relay receipt means the original HTTP response arrived; inspect its responseBody to determine whether the remote task itself completed. A submitted or working task is not a completed user objective.
5. `a2a_task(targetAgentId, taskId)`: query a task created by this same caller for state, text, artifacts and permission metadata. Enterprise mode checks task_read and stable task ownership; random task IDs or an old identity's task are not a valid permission probe.
6. `a2a_cancel(targetAgentId, taskId)`: request cancellation when asked. Query afterwards until the actual canceled state arrives. Desktop localassistant targets may explicitly report cancellation unsupported.
7. `a2a_permission(targetAgentId, taskId, requestId, optionId)`: only after the human explicitly chooses an option, send that exact original optionId and preserve requestId's string/number type. Show the actual tool details and options first. Never select an approval merely to continue execution.
8. `a2a_release(targetAgentId, taskId, cloudTaskId?)`: only when the human explicitly asks to abandon unresolved tracking. The target requires an inactive cloud session and verifies recovered creation IDs by their original cloudName. This marks tracking rejected/unverified, not remotely canceled or successfully completed. Never release an unknown task automatically to free a queue.

## Results and recovery

Persist/report the returned relayRequestId, task ID and context ID. A Relay timeout or pending/unknown receipt does not prove non-execution. Query `a2a_request` before any retry; missing/expired journal evidence also does not permit resending under a new messageId. The Relay deduplicates the original stable messageId within its retention window. Do not claim a task is safe to repeat merely because a connection failed.

Relay supports durable receipts. A receipt 404 can mean wrong caller, expired/no reservation or revoked target access; never conclude that enterprise journaling is disabled. JSON-RPC id is response correlation, messageId is instruction identity, relayRequestId identifies the receipt, and taskId identifies the target task; keep them separate. Receipt completion does not establish task completion.

`ListTasks` / `tasks/list` is unsupported through Relay (HTTP 501 rpc_method_not_supported; older releases returned 403). Do not infer missing invoke permission or ask for another grant from that failure. GetTask 403 can mean missing task_read or wrong ownership. JSON-RPC -32602 means invalid request parameters, not an ACL failure; only an explicit rejection before task creation establishes that the malformed request created no task. Tool registration and a readable card also do not prove all task operations are allowed.

Respect task states: submitted/working continue tracking; input-required needs user input or inspection; completed requires the target's actual completion signal; failed/rejected/canceled are not success. Return verified output and available artifact locations. `agent:///` locations belong to the cloud sandbox and are not automatically public download URLs.

For WorkBuddy receiving tasks, a separate managed desktop/cloud adapter must be online and authorized through the Buddy application's Open API permissions. Installing this MCP connector provides the controller tools; it does not itself deploy that receiving adapter or create an upstream account grant. A cloud target uses Open API + ACP; PC uses localassistant. Use their advertised capabilities and preserve their result correlation rules.

## First-use guidance for WorkBuddy targets

Before first desktop use, explain the receiving-side prerequisites once: the execution PC must have WorkBuddy logged in, its receiving adapter must complete account authorization, and the user must enable 连接移动端 → 小程序 → 允许移动端连接此设备 on that PC. The receiving adapter's `platform login` opens the guided authorization flow; `doctor` returns the next required actions. PC online status alone does not verify remote-control permission. Never enable remote access, approve a permission or change private WorkBuddy settings automatically. A cloud target does not need that desktop switch.

If a task reports `workbuddy_not_authorized`, tell the user to authorize the receiving adapter's WorkBuddy account, not to redo this controller's MCP OAuth. If it reports `blockedReason=workbuddy_channel_not_configured`, show the exact desktop switch instructions and the target's rejection state. Do not keep polling a terminal rejection as if it were working and do not automatically resend. General instructions are at https://dsh-relay.chuanbota.com/oauth/workbuddy/setup (add mode=desktop or mode=cloud when known); that public guide carries no account credentials and cannot replace the receiving adapter's own authorization link. Once setup is confirmed, avoid repeating first-use instructions unless a prerequisite actually fails.
