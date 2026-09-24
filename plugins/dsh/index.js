import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
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
  binary: z.string(), state: z.string(),
  localTokenEnv: z.string(), allowInsecure: z.boolean().default(false),
});

export function apply(ctx, config) {
  const state = config.state || join(homedir(), '.config', 'a2a-connector', 'dsh.json');
  const binary = config.binary || process.execPath;
  const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
  const args = [script, '-relay', config.relay, '-local', config.local, '-state', state];
  if (config.allowInsecure) args.push('-allow-insecure');
  const env = { ...process.env };
  if (config.localTokenEnv) env.A2A_LOCAL_TOKEN = process.env[config.localTokenEnv] || '';
  let child;
  async function start() {
    if (child) return;
    try { await access(state); } catch { return; }
    child = spawn(binary, args, { stdio: 'ignore', env });
    child.once('error', () => { child = undefined; });
    child.once('exit', () => { child = undefined; });
  }
  ctx.effect(() => {
    void start();
    return () => { child?.kill('SIGTERM'); child = undefined; };
  });
  ctx.tools.register(defineTool({
    name: 'a2a_connector_pair',
    description: 'Pair this DSH Agent with the A2A Relay. Ask the operator for a one-time pair_ code first.',
    parameters: { code: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, result) => [{ type: 'text', text: result.text }] },
    async execute({ code }) {
      if (!code.startsWith('pair_')) throw new Error('A Relay pairing code is required');
      await run(binary, [...args, '-enroll-only'], { timeout: 20000, env: { ...env, A2A_PAIR_CODE: code } });
      child?.kill('SIGTERM'); child = undefined;
      await start();
      return { text: 'A2A Connector paired and started.' };
    },
  }));
}
