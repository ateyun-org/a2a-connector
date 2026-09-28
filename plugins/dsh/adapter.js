import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createAdapterServer } from './adapter-server.js';
import { listenWithNextPort, publishAdapterPort } from './adapter-port.js';

export const name = 'dsh-a2a-adapter';
export const inject = ['agents', 'agentDefaultModel', 'sessions'];
export const Config = z.object({
  port: z.number().default(9900),
  portKey: z.string().default('default'),
  portAttempts: z.number().default(20),
  name: z.string().default('DSH Agent'),
  description: z.string(),
  skills: z.array(z.object({
    id: z.string().required(), name: z.string().required(),
    description: z.string().required(), tags: z.array(z.string()).default([]),
  })),
  tokenEnv: z.string().required(),
});

export function createDSHSessionFactory(ctx) {
  return async () => {
    const selection = ctx.agentDefaultModel.currentSelection();
    const handle = await ctx.agents.create({
      sessionId: `session-${randomUUID()}`, meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: agentCtx => { installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    const { agent } = handle;
    let cancelled = false;
    return {
      async run(text) {
        cancelled = false;
        await agent.whenIdle();
        if (cancelled) return { text: '', completed: false };
        const firstSeq = agent.session.seq;
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        await agent.whenIdle();
        await ctx.sessions.flush(agent.session);
        let output = '', reason;
        for (let seq = firstSeq; seq < agent.session.seq; seq++) {
          const event = agent.session.eventAt(seq);
          if (event?.type === 'assistant/message') {
            const value = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('');
            if (value) output = value;
          }
          if (event?.type === 'turn/end') reason = event.data.reason;
        }
        return { text: output, completed: reason?.kind === 'completed' };
      },
      cancel: () => { cancelled = true; agent.cancel({ kind: 'user' }); },
      dispose: () => handle.dispose(),
    };
  };
}

export async function apply(ctx, config) {
  const adapter = createAdapterServer({ token: process.env[config.tokenEnv], name: config.name,
    description: config.description, skills: config.skills,
    createSession: createDSHSessionFactory(ctx) });
  const port = await listenWithNextPort(adapter.server, config.port, config.portAttempts);
  let unpublish;
  try { unpublish = publishAdapterPort(config.portKey, port); }
  catch (error) { await adapter.close(); throw error; }
  ctx.effect(() => async () => { unpublish(); await adapter.close(); });
}
