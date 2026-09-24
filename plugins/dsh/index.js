import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

const run = promisify(execFile);
export const name = 'a2a-connector';
export const inject = ['tools'];
export const Config = z.object({
  relay: z.string().required(), local: z.string().required(),
  binary: z.string(), state: z.string(), agentId: z.string(),
  localTokenEnv: z.string(), allowInsecure: z.boolean().default(false),
});

export function apply(ctx, config) {
  const state = config.state || join(homedir(), '.config', 'a2a-connector', 'dsh.json');
  const binary = config.binary || process.execPath;
  const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
  const args = [script, '-relay', config.relay, '-local', config.local, '-state', state];
  if (config.agentId) args.push('-agent-id', config.agentId);
  if (config.allowInsecure) args.push('-allow-insecure');
  const env = { ...process.env };
  if (config.localTokenEnv) env.A2A_LOCAL_TOKEN = process.env[config.localTokenEnv] || '';
  let child;
  async function start() {
    if (child) return;
    child = spawn(binary, [...args, '-auto-pair'], { stdio: 'ignore', env });
    child.once('error', () => { child = undefined; });
    child.once('exit', () => { child = undefined; });
  }
  ctx.effect(() => {
    void start();
    return () => { child?.kill('SIGTERM'); child = undefined; };
  });
  ctx.tools.register(defineTool({
    name: 'a2a_connector_pair',
    description: 'Show this Agent’s pending pairing request and approval code. Optional code supports manual pairing.',
    parameters: { code: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, result) => [{ type: 'text', text: result.text }] },
    async execute({ code }) {
      if (code) {
        if (!code.startsWith('pair_')) throw new Error('Invalid pairing code');
        child?.kill('SIGTERM'); child = undefined;
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
}
