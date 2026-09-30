import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { selectA2A } from './a2a-selection.js';

const run = promisify(execFile);

// A plain plugin entry is supported by legacy hosts that lack plugin-sdk/plugin-entry.
export default {
  id: 'a2a-connector', name: 'A2A Connector', description: 'Connect this agent to an A2A Relay',
  register(api) {
    const config = api.pluginConfig ?? {};
    const script = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'connector', 'cli.js');
    const binary = config.binary || process.execPath;
    const state = config.state || join(homedir(), '.config', 'a2a-connector', 'openclaw.json');
    let child, adapter, args, env, preparing;
    const prepare = () => preparing ??= (async () => {
      const localToken = config.localTokenEnv ? process.env[config.localTokenEnv] : undefined;
      if (config.localTokenEnv && !localToken) throw new Error(`Missing local A2A token environment variable: ${config.localTokenEnv}`);
      const selected = await selectA2A({ config, hostConfig: api.config, token: localToken });
      let local = selected.local, token = localToken;
      if (selected.mode === 'compat') {
        // Load and provision the compatibility implementation only after confirmed absence.
        let createAdapterServer, listenAdapter, createAgentDriver;
        try {
          ({ createAdapterServer, listenAdapter } = await import('./adapter-server.js'));
          ({ createAgentDriver } = await import('./agent-driver.js'));
        } catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('This installation uses native A2A. After downgrading OpenClaw, reinstall with scripts/install-openclaw.mjs to add compatibility A2A.');
          throw error;
        }
        token = randomBytes(32).toString('hex');
        const agent = config.openclawAgent || api.config?.agents?.list?.find(a => a.default)?.id ||
          api.config?.agents?.list?.[0]?.id || 'main';
        adapter = createAdapterServer({ token, agent, name: config.name || `OpenClaw ${agent}`,
          createSession: createAgentDriver({ binary: config.openclawBinary || 'openclaw',
            args: config.openclawArgs || [], agent, timeoutMs: config.taskTimeoutMs ?? 600000 }) });
        try { local = `http://127.0.0.1:${await listenAdapter(adapter.server, config.port ?? 9900, config.portAttempts ?? 20)}`; }
        catch (error) { await adapter.close(); adapter = undefined; throw error; }
      }
      args = [script, '-relay', config.relay, '-local', local, '-state', state];
      if (config.agentId) args.push('-agent-id', config.agentId);
      if (config.allowInsecure) args.push('-allow-insecure');
      env = { ...process.env, A2A_LOCAL_TOKEN: token || '' };
      api.logger?.info?.(`A2A Connector: ${selected.mode} A2A at ${local}`);
    })().catch(error => { preparing = undefined; throw error; });
    const start = async () => {
      await prepare();
      if (child) return;
      const active = spawn(binary, [...args, '-auto-pair'], { stdio: 'ignore', env });
      child = active;
      active.once('error', error => { api.logger?.error?.(`A2A Connector failed: ${error.message}`); if (child === active) child = undefined; });
      active.once('exit', () => { if (child === active) child = undefined; });
    };
    async function stopChild() {
      const active = child;
      if (!active) return;
      if (active.exitCode === null && active.signalCode === null) {
        const stopped = new Promise(resolve => active.once('close', resolve));
        const timer = setTimeout(() => active.kill('SIGKILL'), 5000);
        try { active.kill('SIGTERM'); await stopped; }
        finally { clearTimeout(timer); }
      }
      if (child === active) child = undefined;
    }
    api.registerService({
      id: 'a2a-connector',
      start,
      async stop() {
        if (preparing) await preparing.catch(() => {});
        await stopChild();
        await adapter?.close();
        adapter = undefined; preparing = undefined; args = undefined; env = undefined;
      },
    });
    api.registerTool({
      name: 'a2a_connector_pair',
      description: 'Show this Agent’s pending pairing request and approval code. An optional one-time pair_ code supports manual pairing.',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Optional one-time pair_ code' } }, additionalProperties: false },
      async execute(_id, params) {
        await prepare();
        if (params.code) {
          if (!params.code.startsWith('pair_')) throw new Error('Invalid pairing code');
          await stopChild();
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
};
