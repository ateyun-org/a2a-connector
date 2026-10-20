---
name: a2a-coordination
description: Use Chuanbota's OAuth-protected MCP tools to delegate authorized A2A tasks, track durable requests and retrieve results.
---

The connector supplies actual remote MCP tools. Buddy application modes and capsules are task presets; they do not establish connections or grant access.

## Connection

Use WorkBuddy's connector connection flow. OAuth discovers the Relay's metadata, registers a public client and uses PKCE. The browser shows an exact Agent ID and confirmation code. The Relay administrator must approve that identity and separately select permitted targets in `/pair/list`. Then the user confirms consent. Do not automatically approve pairing, grant targets, select wildcard access or handle administrator credentials with model tools. No administrator tool is exposed.

The connector uses its own OAuth tokens. They are distinct from the Buddy application's Client Secret and from upstream WorkBuddy Open API/ACP tokens. Never ask for or include those secrets in prompts, tool arguments or output. User pairing approvals and target grants remain mandatory even after installing the connector.

## Tools

1. `a2a_targets`: list exact authorized Agent IDs and online state. Empty results mean no target grants; ask the administrator to grant the exact needed targets.
2. `a2a_agent(targetAgentId)`: inspect the live Agent Card and its real skills before delegation.
3. `a2a_send(targetAgentId, messageId, text, contextId?, taskId?)`: send an instruction once. Choose a unique stable messageId and retain it for that exact instruction. Use the original contextId for an intentional follow-up. Include taskId only if that target supports continuing the original input-required task. A duplicate ID with changed content is invalid.
4. `a2a_request(relayRequestId)`: recover the original durable receipt after timeout/disconnection. A completed Relay receipt means the original HTTP response arrived; inspect its responseBody to determine whether the remote task itself completed. A submitted or working task is not a completed user objective.
5. `a2a_task(targetAgentId, taskId)`: query the remote task for state, text, artifacts and permission metadata.
6. `a2a_cancel(targetAgentId, taskId)`: request cancellation when asked. Query afterwards until the actual canceled state arrives. Desktop localassistant targets may explicitly report cancellation unsupported.
7. `a2a_permission(targetAgentId, taskId, requestId, optionId)`: only after the human explicitly chooses an option, send that exact original optionId and preserve requestId's string/number type. Show the actual tool details and options first. Never select an approval merely to continue execution.
8. `a2a_release(targetAgentId, taskId, cloudTaskId?)`: only when the human explicitly asks to abandon unresolved tracking. The target requires an inactive cloud session and verifies recovered creation IDs by their original cloudName. This marks tracking rejected/unverified, not remotely canceled or successfully completed. Never release an unknown task automatically to free a queue.

## Results and recovery

Persist/report the returned relayRequestId, task ID and context ID. A Relay timeout or pending/unknown receipt does not prove non-execution. Query `a2a_request` before any retry; missing/expired journal evidence also does not permit resending under a new messageId. The Relay deduplicates the original stable messageId within its retention window. Do not claim a task is safe to repeat merely because a connection failed.

Respect task states: submitted/working continue tracking; input-required needs user input or inspection; completed requires the target's actual completion signal; failed/rejected/canceled are not success. Return verified output and available artifact locations. `agent:///` locations belong to the cloud sandbox and are not automatically public download URLs.

For WorkBuddy receiving tasks, a separate managed desktop/cloud adapter must be online and authorized through the Buddy application's Open API permissions. Installing this MCP connector provides the controller tools; it does not itself deploy that receiving adapter or create an upstream account grant. A cloud target uses Open API + ACP; PC uses localassistant. Use their advertised capabilities and preserve their result correlation rules.
