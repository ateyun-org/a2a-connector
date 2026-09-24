import { spawn, execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Type } from 'typebox';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const run = promisify(execFile);

export default definePluginEntry({
  id: 'a2a-connector', name: 'A2A Connector', description: 'Connect this agent to an A2A Relay',
  register(api) {
    const config = api.pluginConfig ?? {};
    const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
    const binary = config.binary || process.execPath;
    const state = config.state || join(homedir(), '.config', 'a2a-connector', 'openclaw.json');
    const args = [script, '-relay', config.relay, '-local', config.local, '-state', state];
    if (config.agentId) args.push('-agent-id', config.agentId);
    if (config.allowInsecure) args.push('-allow-insecure');
    const env = { ...process.env };
    if (config.localTokenEnv) env.A2A_LOCAL_TOKEN = process.env[config.localTokenEnv] || '';
    let child;
    const start = async () => {
      if (child) return;
      child = spawn(binary, [...args, '-auto-pair'], { stdio: 'ignore', env });
      child.once('error', error => { api.logger?.error?.(`A2A Connector failed: ${error.message}`); child = undefined; });
      child.once('exit', () => { child = undefined; });
    };
    api.registerService({
      id: 'a2a-connector',
      start,
      stop() { child?.kill('SIGTERM'); child = undefined; },
    });
    api.registerTool({
      name: 'a2a_connector_pair',
      description: 'Show this Agent’s pending pairing request and approval code. An optional one-time pair_ code supports manual pairing.',
      parameters: Type.Object({ code: Type.Optional(Type.String({ description: 'Optional one-time pair_ code' })) }),
      async execute(_id, params) {
        if (params.code) {
          if (!params.code.startsWith('pair_')) throw new Error('Invalid pairing code');
          child?.kill('SIGTERM'); child = undefined;
          await run(binary, [...args, '-enroll-only'], { timeout: 20000, env: { ...env, A2A_PAIR_CODE: params.code } });
          await start();
          return { content: [{ type: 'text', text: 'A2A Connector paired and started.' }] };
        }
        const { stdout } = await run(binary, [...args, '-request-only'], { timeout: 20000, env });
        await start();
        const status = JSON.parse(stdout);
        return { content: [{ type: 'text', text: status.status === 'paired'
          ? `Already paired: ${status.agentId}`
          : `Approve ${status.agentId} at ${status.approvalURL}. Confirmation code: ${status.confirmationCode}` }] };
      },
    });
  },
});
