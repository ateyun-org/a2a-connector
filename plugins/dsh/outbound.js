import { defineTool } from '@deepseek-ai/dsh-tools';
import { A2AOrchestrator } from './orchestrator.js';

const output = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', required: true },
} };

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
  ctx.tools.register(tool('a2a_agents', `Inspect configured A2A agents before delegation: availability, purpose, when to use, exclusions, and live Agent Card skills. ${catalog}`, {},
    async () => JSON.stringify(await a2a.listAgents())));
  ctx.tools.register(tool('a2a_send', `Send a text message to an A2A agent. Choose the target using a2a_agents. ${catalog} For a long task, keep the returned conversation ID and check it later with a2a_task. Supply conversation_id to continue an earlier conversation; the returned ID can also be used for follow-up and cancellation.`, {
    agent_id: { type: 'string', required: true, description: 'Configured remote agent id.' },
    message: { type: 'string', required: true, description: 'Text request for the remote agent.' },
    conversation_id: { type: 'string', description: 'Existing A2A conversation ID, when continuing.' },
  }, async (args, parentId, signal) => {
    const { conversation, response } = await a2a.send({ agentId: args.agent_id,
      parentId, content: [{ type: 'text', text: args.message }], conversationId: args.conversation_id, signal });
    return JSON.stringify({ conversationId: conversation.id, taskId: conversation.taskId,
      contextId: conversation.contextId, state: conversation.state,
      response: 'status' in response ? undefined : response.parts?.map(p => p.content?.$case === 'text' ? p.content.value : '[non-text part]') });
  }));
  ctx.tools.register(tool('a2a_task', 'Get the latest status and output of an A2A conversation owned by this DSH session.', {
    conversation_id: { type: 'string', required: true },
  }, async (args, parentId, signal) => {
    const task = await a2a.getTask(args.conversation_id, parentId, { signal });
    return JSON.stringify({ conversationId: args.conversation_id, taskId: task.id,
      state: task.status?.state, status: task.status?.message?.parts,
      artifacts: task.artifacts });
  }));
  ctx.tools.register(tool('a2a_cancel', 'Request cancellation of a running A2A task owned by this DSH session.', {
    conversation_id: { type: 'string', required: true },
  }, async (args, parentId, signal) => JSON.stringify(await a2a.cancel(args.conversation_id, parentId, { signal }))));
  ctx.tools.register(tool('a2a_conversations', 'List A2A conversations started by this DSH session.', {},
    async (_args, parentId) => JSON.stringify(await a2a.listConversations(parentId))));
  return a2a;
}
