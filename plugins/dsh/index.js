import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createAdapterServer } from './adapter-server.js';
import { listenWithNextPort } from './adapter-port.js';
import { createDSHSessionFactory } from './dsh-session.js';
import { installOutbound } from './outbound.js';
import { createProcessSupervisor } from './vendor/connector/process-supervisor.js';

export { A2AOrchestrator, a2aTaskState, responseParts } from './orchestrator.js';

const run = promisify(execFile);
export const name = 'a2a-connector';
export const inject = ['tools', 'agents', 'agentDefaultModel', 'sessions', 'subagents'];
export const Config = z.object({
  relay: z.string().required(), local: z.string().default('auto'),
  port: z.number().default(9900), portAttempts: z.number().default(20),
  name: z.string().default('DSH Agent'), description: z.string(),
  skills: z.array(z.object({
    id: z.string().required(), name: z.string().required(),
    description: z.string().required(), tags: z.array(z.string()).default([]),
  })),
  binary: z.string(), state: z.string(), agentId: z.string(),
  localTokenEnv: z.string(), allowInsecure: z.boolean().default(false),
  storePath: z.string(), connectorState: z.string(),
  pollIntervalMs: z.number().min(100).default(1000),
  requestTimeoutMs: z.number().min(1000).default(600000),
  taskTimeoutMs: z.number().min(1000).default(1800000),
  maxPollIntervalMs: z.number().min(100).default(30000),
  maxRequestBodyBytes: z.number().min(1).max(16777216).default(1048576),
  agents: z.array(z.object({
    id: z.string().required(), purpose: z.string(), whenToUse: z.string(), notFor: z.string(),
    url: z.string(), card: z.string(), cardPath: z.string(),
    tokenEnv: z.string(), apiKeyEnv: z.string(), apiKeyHeader: z.string(),
    allowHttp: z.boolean().default(false), allowedOrigins: z.array(z.string()).default([]),
  })).default([]),
});

export async function apply(ctx, config) {
  const state = config.state || join(homedir(), '.config', 'a2a-connector', 'dsh.json');
  const binary = config.binary || process.execPath;
  const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
  let adapter, local = config.local || 'auto', localToken;
  if (local === 'auto') {
    localToken = randomBytes(32).toString('hex');
    adapter = createAdapterServer({ token: localToken, name: config.name,
      description: config.description, skills: config.skills,
      createSession: createDSHSessionFactory(ctx), maxRequestBodyBytes: config.maxRequestBodyBytes ?? 1048576 });
    try {
      const port = await listenWithNextPort(adapter.server, config.port ?? 9900, config.portAttempts ?? 20);
      local = `http://127.0.0.1:${port}`;
    } catch (error) { await adapter.close(); throw error; }
  }
  const args = [script, '-relay', config.relay, '-local', local, '-state', state,
    '-max-request-body', String(config.maxRequestBodyBytes ?? (adapter ? 1048576 : 16777216))];
  if (config.agentId) args.push('-agent-id', config.agentId);
  if (config.allowInsecure) args.push('-allow-insecure');
  const env = { ...process.env };
  if (adapter) env.A2A_LOCAL_TOKEN = localToken;
  else if (config.localTokenEnv) env.A2A_LOCAL_TOKEN = process.env[config.localTokenEnv] || '';
  let outbound;
  const supervisor = createProcessSupervisor({
    launch: () => spawn(binary, [...args, '-auto-pair'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env }),
  });
  const { start, stop, remember } = supervisor;
  try {
    if (config.agents?.length) {
      outbound = installOutbound(ctx, { ...config, connectorState: config.connectorState || state,
        storePath: config.storePath || `${state}.conversations.json` });
    }
    ctx.tools.register(defineTool({
      name: 'a2a_connector_status', description: 'Inspect this Connector process and inbound WSS tunnel health, plus recent bounded logs. Remote Agent Card availability is outbound only.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, result) => [{ type: 'text', text: result.text }] },
      async execute() {
        const { stdout } = await run(binary, [...args, '-status'], { timeout: 10000, env });
        return { text: JSON.stringify({ ...JSON.parse(stdout), ...supervisor.status() }) };
      },
    }));
    ctx.tools.register(defineTool({
      name: 'a2a_connector_pair',
      description: 'Show this Agent’s pending pairing request and approval code. Optional code supports manual pairing.',
      parameters: { code: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, result) => [{ type: 'text', text: result.text }] },
      async execute({ code }) {
        if (code) {
          if (!code.startsWith('pair_')) throw new Error('Invalid pairing code');
          await stop();
          await run(binary, [...args, '-enroll-only'], { timeout: 20000, env: { ...env, A2A_PAIR_CODE: code } });
          await start();
          return { text: 'A2A Connector paired and started.' };
        }
        const { stdout } = await run(binary, [...args, '-request-only'], { timeout: 20000, env });
        await start();
        const status = JSON.parse(stdout);
        return { text: status.status === 'paired' ? `Already paired: ${status.agentId}`
          : `Approve ${status.agentId} at ${status.approvalURL}. Confirmation code: ${status.confirmationCode}` };
      },
    }));
    ctx.effect(() => {
      start();
      void outbound?.validateTargets().then(values => {
        for (const value of values) if (value.grantDiagnostic) remember(Buffer.from(value.grantDiagnostic + '\n'));
      }).catch(() => remember(Buffer.from('Relay target validation unavailable\n')));
      return async () => { try { await stop(); } finally { await adapter?.close(); } };
    });
  } catch (error) { await adapter?.close(); throw error; }
}
