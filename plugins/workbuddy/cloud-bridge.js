import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './desktop-bridge.js';
import { terminal } from './task-store.js';
import { ACPClient } from './acp-client.js';
import { cloudTaskId } from './cloud-api.js';

const now = () => new Date().toISOString();
const bootstrap = 'Initialize this A2A cloud session only. Reply READY and wait for the next instruction. Do not execute tools or any other task.';

/** Serialized cloud turns. Only the matching session/prompt response completes a turn. */
export class CloudBridge {
  constructor({ api, store, taskId, cwd = '/workspace', clientFactory, resultTimeoutMs = 30 * 60000 }) {
    if (taskId !== undefined) cloudTaskId(taskId);
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1024 || /[\u0000-\u001f]/.test(cwd)) throw new Error('Invalid cloud working directory');
    Object.assign(this, { api, store, taskId, cwd, resultTimeoutMs });
    this.controller = new AbortController();
    this.clientFactory = clientFactory || (options => new ACPClient(options));
    this.operations = new Set();
    this.clients = new Map();
    this.mode = 'cloud';
  }

  async start() {
    await this.store.transact(tasks => {
      for (const task of tasks) if (!terminal(task)) {
        task.state = 'TASK_STATE_INPUT_REQUIRED'; task.dispatchState = 'unknown';
        task.output = 'Cloud runner restarted. Inspect the original cloud task; no creation or prompt was repeated.';
        task.permission = undefined; task.updatedAt = now();
      }
    });
  }

  async get(id) {
    const task = (await this.store.list()).find(value => value.id === id);
    if (!task) throw new BridgeError(-32001, 'Task not found');
    return task;
  }

  async patch(id, update) {
    return this.store.transact(tasks => {
      const task = tasks.find(value => value.id === id);
      if (!task) throw new BridgeError(-32001, 'Task not found');
      Object.assign(task, update, { updatedAt: now() });
      return task;
    });
  }

  async submit(message) {
    if (!message || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string' || !message.messageId.trim() ||
        message.messageId.length > 256 || message.taskId || !Array.isArray(message.parts) || !message.parts.length ||
        message.parts.some(part => typeof part?.text !== 'string') || !message.parts.some(part => part.text.trim()) ||
        (message.contextId !== undefined && (typeof message.contextId !== 'string' || !message.contextId || message.contextId.length > 256))) {
      throw new BridgeError(-32602, 'A non-empty user text message and unique messageId are required');
    }
    const prompt = message.parts.map(part => part.text).join('\n');
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new BridgeError(-32602, 'Task text exceeds 256 KiB');
    const fingerprint = createHash('sha256').update(JSON.stringify([prompt, message.contextId || null])).digest('hex');
    let created = false;
    const task = await this.store.transact(tasks => {
      const prior = tasks.find(value => value.messageId === message.messageId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new BridgeError(-32602, 'messageId was already used with different task content');
        return prior;
      }
      if (tasks.some(value => !terminal(value))) throw new BridgeError(-32000, 'WorkBuddy cloud has an active or unresolved turn; query it before submitting another');
      const context = message.contextId && tasks.findLast(value => value.contextId === message.contextId);
      if (message.contextId && !context?.remoteTaskId) throw new BridgeError(-32602, 'Unknown or expired cloud contextId');
      const value = { id: randomUUID(), contextId: message.contextId || randomUUID(), messageId: message.messageId,
        fingerprint, prompt, output: '', mode: 'cloud', sharedCloudSession: !!this.taskId,
        remoteTaskId: this.taskId || context?.remoteTaskId, artifacts: [],
        state: 'TASK_STATE_SUBMITTED', dispatchState: 'reserved', createdAt: now(), updatedAt: now() };
      tasks.push(value); created = true;
      return value;
    });
    if (created) {
      const operation = this.dispatch(task.id);
      this.operations.add(operation);
      operation.catch(() => {}).finally(() => this.operations.delete(operation));
    }
    return task;
  }

  async event(id, message) {
    const task = await this.get(id);
    if (message.params?.sessionId !== task.remoteTaskId || terminal(task)) return;
    if (message.method === 'session/request_permission' && message.id !== undefined) {
      const params = message.params;
      if ((typeof message.id !== 'string' && !(typeof message.id === 'number' && Number.isFinite(message.id))) ||
          !Array.isArray(params.options) || params.options.length > 32 || params.options.some(option => typeof option?.optionId !== 'string' || option.optionId.length > 256) ||
          Buffer.byteLength(JSON.stringify(params)) > 64 * 1024) throw new Error('Invalid ACP permission request');
      await this.patch(id, { state: 'TASK_STATE_INPUT_REQUIRED', permission: { requestId: message.id,
        options: params.options, toolCall: params.toolCall }, output: 'Cloud task requires an explicit user decision. Review the permission details before responding.' });
    } else if (message.method === 'session/update') {
      const update = message.params.update;
      // session/load replays old conversation chunks. Capture only this prompt's live output.
      if (task.dispatchState === 'sent' && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        if (typeof update.content.text !== 'string') return;
        if (Buffer.byteLength((task.answer || '') + update.content.text) > 512 * 1024) throw new Error('Cloud output exceeds journal limit');
        await this.patch(id, { answer: (task.answer || '') + update.content.text,
          ...(task.permission ? {} : { output: (task.answer || '') + update.content.text }) });
      }
    } else if (message.method === '_codebuddy.ai/artifact' && task.dispatchState === 'sent') {
      const { artifact, event } = message.params;
      if (!artifact || typeof artifact.uri !== 'string' || !artifact.uri.startsWith('agent:///') || artifact.uri.length > 2048 ||
          !['created', 'updated', 'deleted'].includes(event)) return;
      const artifacts = task.artifacts.filter(value => value.uri !== artifact.uri);
      if (event !== 'deleted') {
        if (artifacts.length >= 128 || Buffer.byteLength(JSON.stringify(artifact)) > 256 * 1024) throw new Error('Cloud artifact limit exceeded');
        // Do not copy signed download URLs, task tickets, or unknown provider fields into A2A.
        const value = { uri: artifact.uri };
        for (const key of ['type', 'name', 'title', 'description', 'mimeType', 'text', 'size']) {
          if (typeof artifact[key] === 'string' || typeof artifact[key] === 'number') value[key] = artifact[key];
        }
        artifacts.push(value);
      }
      await this.patch(id, { artifacts });
    } else if (message.id !== undefined && message.method) {
      const client = this.clients.get(id);
      await client?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
    }
  }

  async dispatch(id) {
    let mayHaveExecuted = false, client;
    try {
      let task = await this.get(id);
      if (!task.remoteTaskId) {
        // Preflight authorization before crossing the non-repeatable creation boundary.
        await this.api.list({ page: 1, size: 1, signal: this.controller.signal });
        await this.patch(id, { dispatchState: 'creating', cloudName: `A2A-${id}` });
        mayHaveExecuted = true;
        const created = await this.api.create({ name: `A2A-${id}`, prompt: bootstrap }, this.controller.signal);
        task = await this.patch(id, { remoteTaskId: created.task_id, dispatchState: 'created' });
      }
      let credentials = await this.api.ready(task.remoteTaskId, { signal: this.controller.signal });
      for (let attempt = 0; attempt < 2; attempt++) {
        client = this.clientFactory({ signal: this.controller.signal, onEvent: event => this.event(id, event) });
        this.clients.set(id, client);
        try { await client.connect(credentials); await client.load(task.remoteTaskId, this.cwd); break; }
        catch (error) {
          await client.close();
          if (error.status !== 401 || attempt !== 0) throw error;
          credentials = await this.api.get(task.remoteTaskId, this.controller.signal);
        }
      }
      // Durable write comes before POST. Recovery never automatically repeats this RPC.
      await this.patch(id, { dispatchState: 'sent', state: 'TASK_STATE_WORKING', promptRequestId: `prompt-${id}`, answer: '', output: '' });
      mayHaveExecuted = true;
      const result = await client.request('session/prompt', { sessionId: task.remoteTaskId,
        prompt: [{ type: 'text', text: task.prompt }] }, { id: `prompt-${id}`, timeoutMs: this.resultTimeoutMs });
      task = await this.get(id);
      const state = { end_turn: 'TASK_STATE_COMPLETED', refusal: 'TASK_STATE_REJECTED', cancelled: 'TASK_STATE_CANCELED' }[result.stopReason] || 'TASK_STATE_INPUT_REQUIRED';
      await this.patch(id, { state, dispatchState: 'sent', stopReason: result.stopReason,
        permission: undefined, output: task.answer || (state === 'TASK_STATE_COMPLETED' ? 'Cloud turn completed without text output.' : `Cloud turn ended: ${result.stopReason || 'unknown'}. Inspect it before continuing.`) });
    } catch (error) {
      await this.patch(id, { state: mayHaveExecuted ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_FAILED',
        dispatchState: mayHaveExecuted ? 'unknown' : 'not-sent', permission: undefined,
        output: mayHaveExecuted ? 'Cloud task outcome requires verification. Inspect the original cloud session; no task or prompt was repeated.' : error.message });
    } finally { this.clients.delete(id); await client?.close(); }
  }

  async respondPermission(id, requestId, optionId) {
    const client = this.clients.get(id);
    // Atomically claim a decision; concurrent retries cannot answer the same server request twice.
    await this.store.transact(tasks => {
      const task = tasks.find(value => value.id === id);
      if (!client || !task?.permission || task.permission.requestId !== requestId ||
          !task.permission.options.some(option => option.optionId === optionId)) throw new BridgeError(-32602, 'No matching pending permission option');
      Object.assign(task, { permission: undefined, state: 'TASK_STATE_WORKING', output: task.answer || '', updatedAt: now() });
    });
    try {
      await client.send({ jsonrpc: '2.0', id: requestId, result: { outcome: { outcome: 'selected', optionId } } });
    } catch { await this.patch(id, { state: 'TASK_STATE_INPUT_REQUIRED', output: 'Permission reply outcome unknown; inspect the original cloud session before replying again.' }); }
    return this.get(id);
  }

  async cancel(id) {
    const task = await this.get(id);
    if (terminal(task)) return task;
    const client = this.clients.get(id);
    if (!client || task.dispatchState !== 'sent') throw new BridgeError(-32002, 'Cloud turn cannot be canceled on this connection; inspect the original WorkBuddy session');
    if (task.permission) {
      await client.send({ jsonrpc: '2.0', id: task.permission.requestId, result: { outcome: { outcome: 'cancelled' } } });
      await this.patch(id, { permission: undefined });
    }
    await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: task.remoteTaskId } });
    return this.get(id); // Await the actual prompt stopReason; sending cancel is not proof of cancellation.
  }

  async release(id, recoveredTaskId) {
    const task = await this.get(id);
    if (task.state !== 'TASK_STATE_INPUT_REQUIRED' || this.clients.has(id)) throw new BridgeError(-32002, 'Only an unresolved turn without a live ACP connection can be released');
    const remoteId = task.remoteTaskId || recoveredTaskId;
    if (!remoteId) throw new BridgeError(-32602, 'Locate the original cloud task by cloudName and provide its task ID');
    const remote = await this.api.get(cloudTaskId(remoteId), this.controller.signal);
    if (!task.remoteTaskId && remote.name !== task.cloudName) throw new BridgeError(-32602, 'Recovered cloud task name does not match the original creation');
    if (!['idle', 'completed', 'failed', 'archived', 'deleted'].includes(remote.status)) {
      throw new BridgeError(-32002, 'Cloud session is still active or awaiting input; resolve it in WorkBuddy before releasing tracking');
    }
    return this.patch(id, { remoteTaskId: remoteId, state: 'TASK_STATE_REJECTED', trackingReleased: true,
      output: 'Tracking closed by explicit request after checking cloud inactivity. The previous round result remains unverified; this does not report successful execution or remote cancellation.' });
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    await Promise.allSettled(this.operations);
  }
}
