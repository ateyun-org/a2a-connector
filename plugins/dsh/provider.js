import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';

export const RELAY_PROVIDER = 'a2a-relay';

class RelayDeepSeekAdapter extends DeepSeekAdapter {
  async *stream(options) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal);
    yield* prepared.stream(options);
  }
}

/** Use the native DSH adapter for reasoning, tools and replay. Only the
 * authenticated Relay origin receives the Connector credential. */
export function installRelayProvider(ctx, relay, { resolveUserId = getOrCreateAnonymousUserId } = {}) {
  const baseURL = `${relay.origin}/relay/provider/anthropic`;
  let current = resolveAdapterOptions({ baseURL, models: [] });
  const connect = async signal => {
    const [catalog, token] = await Promise.all([relay.models({ signal }), relay.credential()]);
    if (!catalog.enabled || !catalog.apiKeyConfigured) throw new LlmError('请由管理员在 Relay 的 DSH 主控页启用 DeepSeek 模型。', 'AUTH');
    const connection = { ...resolveAdapterOptions({ baseURL, models: catalog.models }), relayToken: token };
    current = connection;
    return connection;
  };
  const adapter = new RelayDeepSeekAdapter({
    providerName: 'Relay · DeepSeek', options: () => current, connect,
    discoverModels: async () => (await connect()).models.map(model => ({ provider: RELAY_PROVIDER, ...model })),
    admit(connection, model) {
      if (!connection.models.some(item => item.id === model)) throw new LlmError('此模型未获 Relay 管理员启用。', 'MODEL_NOT_FOUND');
    },
    resolveAuth: async connection => ({ headers: { Authorization: `Bearer ${connection.relayToken}` } }),
    resolveUserId,
    resolveAttachments: () => ctx.get?.('attachments'),
    prepareExtensions: request => ctx.get?.('deepseekLlmApiExtensions')?.prepare(request) ?? Promise.resolve({ fields: {}, accept: async () => {} }),
  });
  ctx.llm.registerAdapter([RELAY_PROVIDER], adapter);
  return adapter;
}
