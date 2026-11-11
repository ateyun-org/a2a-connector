import { createHash } from 'node:crypto';
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL } from './remote-route.js';

export { REMOTE_AGENT_PROVIDER, REMOTE_AGENT_MODEL };
const noRetry = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'a2a-remote-agent.retry');
const invalid = message => new LlmError(message, 'INVALID_REQUEST');

/** The native Agent loop owns input, streaming, history and cancellation.
 * This route transports one identified user message to its bound A2A Agent. */
export class RemoteSessionAdapter extends LlmAdapter {
  constructor(sessions) { super(); this.sessions = sessions; }
  providerInfo(provider) { return { id: provider, name: '远程 Agent · 直聊' }; }
  providerRetryPolicy() { return noRetry; }
  // Native ModelSelect needs a catalog entry to display the pinned route.
  // The target identity remains in the private Session binding, not this catalog.
  async listModels(provider = REMOTE_AGENT_PROVIDER) { return [{ provider, id: REMOTE_AGENT_MODEL, name: '远程 Agent 直聊', inputModalities: ['text'] }]; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: '远程 Agent 直聊', inputModalities: ['text'] };
  }

  async *stream(options) {
    if (options.purpose !== undefined) throw invalid('远程 Agent 直聊不执行辅助模型请求。');
    const binding = await this.sessions.binding(options.sessionId);
    // Keep old saved agent-id routes readable while the guard migrates them.
    if (!binding || (options.model !== REMOTE_AGENT_MODEL && binding.agentId !== options.model)) throw invalid('请从左侧「远程 Agents」打开对应的原生会话。');
    const target = await this.sessions.authorize(binding.agentId, options.signal);
    if (!target.online) throw invalid('远程 Agent 当前离线，请恢复连接后再发送。');
    // SDK projection and other middleware may copy the request object, losing
    // isAgentLoopRequest's WeakSet identity. The durable Session owns user intent.
    let message;
    for (let index = options.messages.length - 1; index >= 0; index--) {
      const item = options.messages[index];
      if (item.role !== 'user') continue;
      message = this.sessions.userInput(options.sessionId, item);
      if (message) break;
    }
    if (!message) throw invalid('此请求没有对应的原生用户消息，请在聊天输入框中发送。');
    if (!Array.isArray(message.content) || message.content.some(part => part.type !== 'text')) {
      throw invalid('远程 Agent 会话目前只接收原生聊天窗口中的文本消息。');
    }
    const content = message.content.map(part => ({ type: 'text', text: part.text }));
    if (!content.some(part => part.text.trim())) throw invalid('请输入消息内容。');
    const parentId = options.sessionId;
    const messageId = createHash('sha256').update(`${parentId}:${binding.agentId}:${message.id}`).digest('hex');
    const a2a = this.sessions.a2a;
    const records = (await a2a.store.list(parentId)).filter(record => record.agentId === binding.agentId);
    const previous = records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    let result;
    if (previous?.messageId === messageId) {
      result = await a2a.reconcile(previous.id, parentId, { signal: options.signal });
    } else {
      if (previous && ['pending', 'unknown'].includes(previous.dispatchState)) {
        throw invalid('上一条请求仍待确认，请先重试上一轮查询结果，再发送新消息。');
      }
      result = await a2a.send({ agentId: binding.agentId, parentId, content,
        conversationId: previous?.id, messageId, signal: options.signal });
    }
    if (!result.response) throw invalid('原请求结果待确认，请稍后重试查询；不会重新派发同一条消息。');
    const outcome = await a2a.waitForResult(result.conversation, result.response, options.signal);
    options.signal?.throwIfAborted();
    if (outcome.stopReason === 'aborted') throw invalid('远程请求已停止。');
    const text = outcome.output.filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (outcome.stopReason === 'error') throw invalid(text || outcome.diagnostic || '远程请求失败，请查询原任务。');
    if (text) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
