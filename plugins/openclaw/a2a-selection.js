import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function localOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search ||
      url.hash || url.username || url.password) throw new Error('local must be an HTTP(S) origin');
  return url.origin;
}

export async function probeA2A(origin, token, fetcher = fetch) {
  const response = await fetcher(`${localOrigin(origin)}/.well-known/agent-card.json`, {
    redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 404) return false;
  if (response.status !== 200) throw new Error(`Local A2A discovery returned ${response.status}; fix the Gateway/A2A authentication`);
  // A login page or a broken card is not evidence that A2A is absent.
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw new Error('Local Agent Card is too large');
  const card = JSON.parse(raw);
  if (typeof card.name !== 'string' || !card.name.trim() ||
      !Array.isArray(card.supportedInterfaces) || !card.supportedInterfaces.some(i => {
        try { return i.protocolBinding === 'JSONRPC' && ['http:', 'https:'].includes(new URL(i.url).protocol); }
        catch { return false; }
      })) throw new Error('Local A2A Agent Card is invalid or has no JSON-RPC interface');
  return true;
}

/** An installed but disabled native plugin is still native support, never legacy. */
export async function selectA2A({ config = {}, hostConfig = {}, token,
  execute = run, fetcher = fetch } = {}) {
  if (config.local && config.local !== 'auto') {
    const local = localOrigin(config.local);
    if (!await probeA2A(local, token, fetcher)) throw new Error('Configured local A2A origin has no Agent Card');
    return { mode: 'existing', local };
  }
  const local = localOrigin(`http://127.0.0.1:${hostConfig.gateway?.port ?? 18789}`);
  // Query capabilities, not the version: forks/backports and disabled plugins matter.
  const { stdout } = await execute(config.openclawBinary || 'openclaw',
    [...(config.openclawArgs || []), 'plugins', 'list', '--json'],
    { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  const inventory = JSON.parse(stdout);
  if (!Array.isArray(inventory.plugins) || inventory.plugins.some(p => typeof p?.id !== 'string')) {
    throw new Error('Cannot determine OpenClaw A2A support: invalid plugin inventory');
  }
  const native = inventory.plugins.some(p => p.id === 'a2a' || p.channelIds?.includes('a2a'));
  if (native || hostConfig.channels?.a2a) {
    if (await probeA2A(local, token, fetcher)) {
      if (!token) throw new Error('Native A2A needs a peer bearer token; configure localTokenEnv with the token in channels.a2a.peers');
      // Public discovery does not validate the peer token. This read-only request does.
      const response = await fetcher(`${local}/a2a/v1`, { method: 'POST', redirect: 'manual',
        signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'connector-auth-probe', method: 'GetTask',
          params: { id: '__a2a_connector_auth_probe__' } }) });
      if (response.status !== 200) throw new Error(`Native A2A task endpoint returned ${response.status}; check the peer token and Gateway configuration`);
      const result = await response.json();
      if (result.jsonrpc !== '2.0' || result.id !== 'connector-auth-probe' || result.error?.code !== -32001) {
        throw new Error('Native A2A task endpoint did not return the expected task-not-found response');
      }
      return { mode: 'native', local };
    }
    throw new Error('OpenClaw has native A2A; enable/configure channels.a2a and reload the Gateway. Compatibility A2A was not started.');
  }
  return { mode: 'compat' };
}
