import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConversationStore } from './store.js';
import { responseParts, stateName } from './orchestrator.js';
import { controlContract } from './control-contract.js';

const PARENT = 'a2a-control-owner-v1';
const active = new Set(['submitted', 'working', 'unspecified']);
const textParts = response => responseParts(response).map(part => part.content?.$case === 'text' ? part.content.value : part.text || '').filter(Boolean).join('\n');

/** A durable, owner-only direct chat surface, isolated from model tool sessions. */
export class ControlChats {
  constructor(a2a, relay, path) {
    this.a2a = a2a; this.relay = relay; this.store = new ConversationStore(path); this.jobs = new Map();
  }

  async targets() { return this.a2a.syncRelayTargets(); }

  async chat({ agentId }) {
    return (await this.store.get(agentId)) || { id: agentId, messages: [], state: 'idle' };
  }

  async send(input) {
    const { agentId, text, messageId } = input;
    if (this.jobs.has(agentId)) return this.chat(input);
    this.jobs.set(agentId, true);
    let started = false;
    try {
    // Re-check the live grant; the list shown in the page is never authority.
    if (!(await this.targets()).some(target => target.agentId === agentId)) throw new Error('此 Agent 已不可访问，请刷新列表。');
    const chat = await this.chat(input);
    if (chat.messageId === messageId) {
      if (chat.messages.find(message => message.role === 'user' && message.messageId === messageId)?.text !== text.trim()) throw new Error('同一消息编号不能用于不同内容。');
      return chat;
    }
    if (['sending', 'queued', 'unknown', 'submitted', 'working'].includes(chat.state)) throw new Error('上一条消息仍在排队、执行或等待确认，请先查询结果。');
    Object.assign(chat, { state: 'sending', messageId, error: '', updatedAt: new Date().toISOString() });
    chat.messages.push({ role: 'user', text: text.trim(), messageId });
    await this.store.put(chat);
    // The durable dispatch survives a page leaving; polling never resends it.
    const job = Promise.resolve().then(async () => {
      const result = await this.a2a.send({ agentId, parentId: PARENT, content: [{ type: 'text', text: text.trim() }],
        conversationId: chat.conversationId, messageId });
      chat.conversationId = result.conversation.id;
      this.observe(chat, result);
      await this.store.put(chat);
    }).catch(async () => {
      let saved;
      try { saved = (await this.a2a.store.list(PARENT)).find(record => record.agentId === agentId && record.messageId === messageId); }
      catch { chat.state = 'unknown'; chat.error = '发送记录暂时不可读，请恢复存储后查询原请求。'; await this.store.put(chat); return; }
      if (saved) chat.conversationId = saved.id;
      chat.state = saved ? 'unknown' : 'failed';
      chat.error = saved ? '发送结果待确认，请查询原请求，避免重复发送。' : '消息尚未发出，请检查授权和连接后再发送。';
      await this.store.put(chat);
    }).finally(() => this.jobs.delete(agentId));
    this.jobs.set(agentId, job);
    // A storage failure is surfaced by the next read/reconciliation. It must
    // not turn a detached UI operation into an unhandled Host rejection.
    void job.catch(() => {});
    started = true;
    return chat;
    } finally { if (!started) this.jobs.delete(agentId); }
  }

  observe(chat, result) {
    chat.state = ['pending', 'unknown'].includes(result.conversation?.dispatchState) ? 'unknown' : stateName(result.conversation?.state);
    chat.error = result.diagnostic || '';
    if (result.relay?.state === 'queued') chat.state = 'queued';
    if (result.response) {
      const text = textParts(result.response);
      if (text) {
        let message = chat.messages.find(item => item.role === 'agent' && item.messageId === chat.messageId);
        if (!message) { message = { role: 'agent', messageId: chat.messageId }; chat.messages.push(message); }
        message.text = text;
      }
    }
    chat.updatedAt = new Date().toISOString();
  }

  async poll(input) {
    const chat = await this.chat(input);
    if (this.jobs.has(input.agentId)) {
      const saved = (await this.a2a.store.list(PARENT)).find(record => record.agentId === input.agentId && record.messageId === chat.messageId);
      if (saved?.relayRequestId) {
        const receipt = await this.relay.request(`/relay/requests/${saved.relayRequestId}`);
        if (receipt.state === 'queued') return { ...chat, state: 'queued' };
      }
      return chat;
    }
    if (!chat.conversationId && chat.messageId) {
      const saved = (await this.a2a.store.list(PARENT)).find(record => record.agentId === input.agentId && record.messageId === chat.messageId);
      if (saved) chat.conversationId = saved.id;
    }
    if (!chat.conversationId) {
      if (chat.state === 'sending') { chat.state = 'unknown'; chat.error = '原发送记录尚未确认，请检查连接后查询，避免重复发送。'; }
      return chat;
    }
    const result = await this.a2a.reconcile(chat.conversationId, PARENT, {});
    this.observe(chat, result);
    await this.store.put(chat);
    return chat;
  }
}

class ControlService extends TypertRemoteService {
  constructor(ctx, chats) { super(ctx, 'a2aControl'); this.chats = chats; }
  owner() {
    if (this.ctx.invocation?.peer?.principal?.kind !== 'owner') throw new Error('仅 DSH 宿主所有者可使用远程 Agent 主控。');
  }
  targets() { this.owner(); return this.chats.targets(); }
  chat(input) { this.owner(); return this.chats.chat(input); }
  send(input) { this.owner(); return this.chats.send(input); }
  poll(input) { this.owner(); return this.chats.poll(input); }
}

export function installControlPage(ctx, a2a, relay, path) {
  const chats = new ControlChats(a2a, relay, path);
  return ctx.inject(['typert'], scope => {
    new ControlService(scope, chats);
    scope.effect(() => scope.typert.register({ package: controlContract.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] }, invocations: controlContract.descriptors }));
  });
}
