import { createHash, randomUUID } from 'node:crypto';
import { terminal } from './task-store.js';

const textOf = message => message.content.filter(part => typeof part === 'string').join('\n');
const timestamp = () => new Date().toISOString();
const marker = id => `[A2A_TASK:${id}]`;
export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function finalResult(message, id) {
  if (message.role !== 'assistant' || message.msg_type !== 'text') return null;
  let text = textOf(message).trim();
  if (text.startsWith('```json\n') && text.endsWith('\n```')) text = text.slice(8, -4).trim();
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (value?.a2aTaskId !== id || typeof value.text !== 'string' ||
      !['completed', 'failed', 'input-required'].includes(value.status)) return null;
  return value;
}

function executionPrompt(task) {
  return `${marker(task.id)}\n执行以下已授权的 A2A 任务，遵守宿主已有权限与审批要求。\n` +
    `任务内容：\n${task.prompt}\n\n` +
    `使用工具实际完成后，最终回复请仅输出一个 JSON 对象：` +
    `{"a2aTaskId":"${task.id}","status":"completed","text":"结果摘要、产物位置及验证依据"}。` +
    `执行失败时 status 为 failed；需要用户补充信息或审批时为 input-required。` +
    `不要在计划或工具执行中的回复里输出 completed。不得跳过审批。`;
}

/** PC localassistant is one shared conversation, so remote tasks are serialized. */
export class DesktopBridge {
  constructor({ api, store, pollIntervalMs = 2000, resultTimeoutMs = 30 * 60000 }) {
    this.api = api;
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.resultTimeoutMs = resultTimeoutMs;
    this.operations = new Set();
    this.refreshing = new Set();
    this.controller = new AbortController();
  }

  track(operation) {
    this.operations.add(operation);
    operation.catch(() => {}).finally(() => this.operations.delete(operation));
  }

  async start() {
    await this.store.transact(tasks => {
      for (const task of tasks) {
        if (!terminal(task) && ['reserved', 'dispatching'].includes(task.dispatchState)) {
          task.dispatchState = 'unknown';
          task.state = 'TASK_STATE_INPUT_REQUIRED';
          task.output = 'Dispatch interrupted; reconciling WorkBuddy history without resending.';
          task.updatedAt = timestamp();
        }
      }
    });
    this.timer = setInterval(() => { this.track(this.refreshActive()); }, this.pollIntervalMs);
    this.timer.unref();
    this.track(this.refreshActive());
  }

  async submit(message) {
    if (!message || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string' ||
        !message.messageId.trim() || message.messageId.length > 256 || !Array.isArray(message.parts) ||
        !message.parts.length || message.parts.some(part => typeof part?.text !== 'string') ||
        !message.parts.some(part => part.text.trim()) || message.taskId ||
        (message.contextId !== undefined && (typeof message.contextId !== 'string' || !message.contextId || message.contextId.length > 256))) {
      throw new BridgeError(-32602, 'A non-empty user text message with a unique messageId is required; approvals remain in WorkBuddy');
    }
    const prompt = message.parts.map(part => part.text).join('\n');
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new BridgeError(-32602, 'Task text exceeds 256 KiB');
    const fingerprint = createHash('sha256').update(JSON.stringify([prompt, message.contextId || null])).digest('hex');
    let created = false;
    const task = await this.store.transact(tasks => {
      const prior = tasks.find(item => item.messageId === message.messageId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new BridgeError(-32602, 'messageId was already used with different task content');
        return prior;
      }
      if (tasks.some(item => !terminal(item))) throw new BridgeError(-32000, 'WorkBuddy desktop already has an active or unresolved task; query it before submitting another');
      if (message.contextId && !tasks.some(item => item.contextId === message.contextId)) {
        throw new BridgeError(-32602, 'Unknown or expired contextId');
      }
      const value = { id: randomUUID(), messageId: message.messageId, fingerprint,
        contextId: message.contextId || randomUUID(), prompt, output: '',
        state: 'TASK_STATE_SUBMITTED', dispatchState: 'reserved', createdAt: timestamp(), updatedAt: timestamp() };
      tasks.push(value);
      created = true;
      return value;
    });
    if (created) this.track(this.dispatch(task.id));
    return task;
  }

  async patch(id, update) {
    return this.store.transact(tasks => {
      const task = tasks.find(item => item.id === id);
      if (!task) throw new BridgeError(-32001, 'Task not found');
      Object.assign(task, update, { updatedAt: timestamp() });
      return task;
    });
  }

  async dispatch(id) {
    let sending = false;
    try {
      const task = await this.get(id);
      const status = await this.api.status(this.controller.signal);
      if (!status.online) throw new Error('WorkBuddy desktop is offline');
      await this.patch(id, { dispatchState: 'dispatching' });
      sending = true;
      const remoteMessageId = await this.api.send(executionPrompt(task), this.controller.signal);
      await this.patch(id, { remoteMessageId, dispatchState: 'sent', state: 'TASK_STATE_WORKING' });
    } catch (error) {
      await this.patch(id, { dispatchState: sending ? 'unknown' : 'not-sent',
        state: sending ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_FAILED',
        output: sending ? 'WorkBuddy send outcome is unknown. Do not resubmit; query this task to reconcile history.' : error.message });
    }
  }

  async get(id) {
    const value = (await this.store.list()).find(task => task.id === id);
    if (!value) throw new BridgeError(-32001, 'Task not found');
    return value;
  }

  async refreshActive() {
    for (const task of await this.store.list()) {
      if (!terminal(task) && !['reserved', 'dispatching'].includes(task.dispatchState)) await this.refresh(task.id);
    }
  }

  async refresh(id) {
    if (this.refreshing.has(id) || this.controller.signal.aborted) return;
    this.refreshing.add(id);
    try {
      let task = await this.get(id);
      if (terminal(task)) return;
      let messages;
      if (task.remoteMessageId) messages = await this.api.messages({ after: task.remoteMessageId, signal: this.controller.signal });
      else {
        messages = [];
        for (let offset = 0; offset < 1000; offset += 100) {
          const page = await this.api.messages({ offset, signal: this.controller.signal });
          messages.push(...page);
          if (page.length < 100) break;
        }
        const sent = messages.find(message => message.role === 'user' && textOf(message).startsWith(marker(id) + '\n'));
        if (sent) task = await this.patch(id, { remoteMessageId: sent.message_id, dispatchState: 'sent', state: 'TASK_STATE_WORKING', output: '' });
      }
      // Never infer completion from a plain assistant message or an unrelated conversation.
      const results = messages.map(message => ({ message, result: finalResult(message, id) })).filter(value => value.result)
        .sort((a, b) => (Date.parse(a.message.created_at) || 0) - (Date.parse(b.message.created_at) || 0));
      // History may arrive newest-first. An older question must not override a final result.
      const result = results.filter(value => value.result.status !== 'input-required').at(-1) || results.at(-1);
      if (result) {
        const state = { completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', 'input-required': 'TASK_STATE_INPUT_REQUIRED' }[result.result.status];
        await this.patch(id, { state, dispatchState: 'sent', output: result.result.text.slice(0, 256 * 1024),
          resultMessageId: result.message.message_id, lastPollError: undefined });
      } else {
        const permission = messages.some(message => /permission|ask[_-]?question/i.test(message.msg_type || ''));
        const overdue = Date.now() - Date.parse(task.createdAt) >= this.resultTimeoutMs;
        await this.patch(id, { ...(permission && task.remoteMessageId ? {
          state: 'TASK_STATE_INPUT_REQUIRED', output: 'WorkBuddy requires user input or approval. Respond in the WorkBuddy desktop, then query this task again.' } : overdue ? {
          state: 'TASK_STATE_INPUT_REQUIRED', output: 'No correlated final result has arrived. Inspect the original task in WorkBuddy; tracking continues without resubmitting.' } : {}), lastPollError: undefined });
      }
    } catch {
      // Failed reads never authorize a second send and never turn an unknown task into success/failure.
      if (!this.controller.signal.aborted) await this.patch(id, { lastPollError: 'WorkBuddy progress unavailable; check authorization and desktop connectivity' });
    } finally { this.refreshing.delete(id); }
  }

  async close() {
    clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled([...this.operations]);
  }
}
