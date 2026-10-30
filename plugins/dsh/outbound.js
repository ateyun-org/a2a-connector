import { defineTool } from '@deepseek-ai/dsh-tools';
import { A2AOrchestrator, responseParts, stateName } from './orchestrator.js';

const output = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', required: true },
} };

const relayGuidance = 'For enterprise Relay, the administrator grants caller → target on the target row at /console → 谁能访问. Cards need discover, sends invoke, owned task reads task_read; personal callers also need member permissions. ListTasks returns only the current caller\'s owned tasks with task_read and Relay pagination; empty results do not prove non-execution. Read this plugin\'s skills/a2a-relay-calling/SKILL.md for the full Relay workflow.';

function tool(name, description, parameters, execute) {
  return defineTool({ name, description, parameters,
    output: { schema: output, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      const parentId = exec.agent?.session?.id;
      if (!parentId) throw new Error(`${name} requires an active DSH agent session`);
      return { text: await execute(args, parentId, exec.signal) };
    },
  });
}

/** Register one provider per configured remote agent, plus model-facing A2A controls. */
export function installOutbound(ctx, config) {
  const a2a = new A2AOrchestrator(config);
  const catalog = config.agents.map(agent => `${agent.id}: ${agent.purpose || 'inspect Agent Card with a2a_agents'}`).join('; ');
  for (const agent of a2a.configuredAgents()) {
    ctx.subagents.registerProvider({
      name: `a2a:${agent.id}`,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false,
        toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: request => a2a.startRun(agent.id, request),
    });
  }
  ctx.tools.register(tool('a2a_agents', `Inspect configured A2A agents before delegation: availability, purpose, when to use, exclusions, and live Agent Card skills. Card availability is not proof of all task permissions. ${relayGuidance} ${catalog}`, {},
    async () => JSON.stringify(await a2a.listAgents())));
  ctx.tools.register(tool('a2a_send', `Send the user's authorized task to an A2A agent; a connection inspection does not itself authorize a real test task. Choose the target using a2a_agents. ${catalog} This tool builds ROLE_USER, messageId and text parts and saves a durable dispatch record; do not hand-write a different protocol. Keep the returned conversation ID and use a2a_task; after uncertainty use a2a_reconcile without another send. Supply conversation_id for an intentional follow-up after completion. ${relayGuidance}`, {
    agent_id: { type: 'string', required: true, description: 'Configured remote agent id.' },
    message: { type: 'string', required: true, description: 'Text request for the remote agent.' },
    conversation_id: { type: 'string', description: 'Existing A2A conversation ID, when continuing.' },
    message_id: { type: 'string', description: 'Optional stable idempotency key. Reuse only for the same dispatch and content; use a2a_reconcile after an unknown outcome.' },
  }, async (args, parentId, signal) => {
    const { conversation, response, diagnostic } = await a2a.send({ agentId: args.agent_id,
      parentId, content: [{ type: 'text', text: args.message }], conversationId: args.conversation_id, messageId: args.message_id, signal });
    return JSON.stringify({ conversationId: conversation.id, taskId: conversation.taskId,
      contextId: conversation.contextId, state: conversation.state, stateName: stateName(conversation.state),
      messageId: conversation.messageId, relayRequestId: conversation.relayRequestId, dispatchState: conversation.dispatchState, diagnostic,
      response: response && (!('status' in response) || ['completed', 'failed', 'canceled', 'rejected'].includes(stateName(conversation.state))) ? responseParts(response) : undefined });
  }));
  ctx.tools.register(tool('a2a_task', 'Get status and output of a conversation owned by this DSH session. Relay also requires task_read and ownership by the same caller Agent. A 403 on an old/foreign task does not establish whether sending is permitted; use the saved conversation ID, not a random task ID.', {
    conversation_id: { type: 'string', required: true },
  }, async (args, parentId, signal) => {
    const task = await a2a.getTask(args.conversation_id, parentId, { signal });
    return JSON.stringify({ conversationId: args.conversation_id, taskId: task.id,
      state: task.status?.state, stateName: stateName(task.status?.state), response: responseParts(task),
      artifacts: task.artifacts?.map(({ parts, ...metadata }) => metadata) });
  }));
  ctx.tools.register(tool('a2a_cancel', 'Request cancellation of a running A2A task owned by this DSH session.', {
    conversation_id: { type: 'string', required: true },
  }, async (args, parentId, signal) => JSON.stringify(await a2a.cancel(args.conversation_id, parentId, { signal }))));
  ctx.tools.register(tool('a2a_conversations', 'List local saved A2A conversations, not the remote ListTasks collection. Explicitly enable include_previous_sessions to inspect historical records read-only; sending/cancelling keeps session ownership.', {
    include_previous_sessions: { type: 'boolean' },
  }, async (args, parentId) => JSON.stringify(await a2a.listConversations(parentId, { includePreviousSessions: args.include_previous_sessions }))));
  ctx.tools.register(tool('a2a_reconcile', 'Recover a pending/unknown dispatch without sending a message. Enterprise Relay supports durable receipts: a 404 means missing/inaccessible evidence, not disabled journaling or proof of non-execution. Relay recovery never falls back to unfiltered ListTasks. Only direct non-Relay endpoints may match messageId in task history. This is client-side recovery, not the unsupported remote ReconcileCloudTask RPC. Keep all original IDs; never automatically resend.', {
    conversation_id: { type: 'string', required: true },
    include_previous_sessions: { type: 'boolean', description: 'Explicit read-only historical access; does not transfer ownership.' },
  }, async (args, parentId, signal) => {
    const result = await a2a.reconcile(args.conversation_id, parentId, { signal, includePreviousSessions: args.include_previous_sessions });
    const { response, ...details } = result;
    return JSON.stringify({ ...details, response: response ? responseParts(response) : undefined,
      stateName: stateName(result.conversation?.state) });
  }));
  return a2a;
}
