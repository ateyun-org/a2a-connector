import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './desktop-bridge.js';
import { terminal } from './task-store.js';
import { ACPClient } from './acp-client.js';
import { cloudTaskId } from './cloud-api.js';

const now = () => new Date().toISOString();
const bootstrap = 'Initialize this A2A cloud session only. Reply READY and wait for the next instruction. Do not execute tools or any other task.';
const endState = reason => ({ end_turn: 'TASK_STATE_COMPLETED', refusal: 'TASK_STATE_REJECTED',
  cancelled: 'TASK_STATE_CANCELED' }[reason] || 'TASK_STATE_INPUT_REQUIRED');
const recoverable = task => task?.state === 'TASK_STATE_INPUT_REQUIRED' && task.dispatchState === 'unknown' &&
  task.businessPromptAttempted === true && task.promptRequestId !== undefined && task.remoteTaskId &&
  !task.sharedCloudSession && task.cloudName === `A2A-${task.id}`;
const providerRequestId = params => params?._meta?.['codebuddy.ai']?.requestId ||
  params?._meta?.['codebuddy.ai/conversationRequestId'] || params?.update?._meta?.['codebuddy.ai/conversationRequestId'];
const userText = params => {
  const blocks = params?._meta?.['codebuddy.ai']?.extra?.sourceContentBlocks;
  return Array.isArray(blocks) && blocks.every(block => block.type === 'text' && typeof block.text === 'string')
    ? blocks.map(block => block.text).join('\n') : params?.update?.content?.text;
};

/** Serialized cloud turns. Only the matching session/prompt response completes a turn. */
export class CloudBridge {
  constructor({ api, store, taskId, cwd = '/workspace', clientFactory, resultTimeoutMs = 30 * 60000,
    autoRecover = true, recoveryIntervalMs = 30000 }) {
    if (taskId !== undefined) cloudTaskId(taskId);
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1024 || /[\u0000-\u001f]/.test(cwd)) throw new Error('Invalid cloud working directory');
    if (!Number.isFinite(recoveryIntervalMs) || recoveryIntervalMs < 1) throw new Error('Invalid recovery interval');
    Object.assign(this, { api, store, taskId, cwd, resultTimeoutMs, autoRecover, recoveryIntervalMs });
    this.controller = new AbortController();
    this.clientFactory = clientFactory || (options => new ACPClient(options));
    this.operations = new Set();
    this.clients = new Map();
    this.reconciliations = new Map();
    this.recoveryTimers = new Map();
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
    for (const task of await this.store.list()) if (recoverable(task)) this.scheduleRecovery(task.id);
  }

  scheduleRecovery(id, delayMs = 0) {
    if (!this.autoRecover || this.controller.signal.aborted || this.recoveryTimers.has(id) || this.reconciliations.has(id)) return;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(id);
      const operation = (async () => {
        try {
          if (!recoverable(await this.get(id))) return;
          try { await this.reconcile(id); }
          catch {
            // Preserve unknown outcomes. Neither missing history nor a transport error justifies resubmission.
            await this.store.transact(tasks => {
              const task = tasks.find(value => value.id === id);
              if (recoverable(task)) Object.assign(task, { recoveryState: task.recoveredOutput ? 'output_recovered' :
                task.artifactRecoveryState === 'recovered' ? 'artifacts_recovered' : 'awaiting_evidence',
                recoveryLastAttemptAt: now() });
            });
          }
          if (recoverable(await this.get(id))) this.scheduleRecovery(id, this.recoveryIntervalMs);
        } catch { /* A journal failure must not escape a background recovery operation. */ }
      })();
      this.operations.add(operation);
      operation.finally(() => this.operations.delete(operation)).catch(() => {});
    }, delayMs);
    timer.unref?.();
    this.recoveryTimers.set(id, timer);
  }

  async refreshTask(id) {
    const task = await this.get(id);
    if (recoverable(task)) this.scheduleRecovery(id);
    // GetTask stays responsive while the receiver reads the original provider history.
    return recoverable(task) && this.autoRecover ? { ...task, recoveryState: task.recoveryState || 'pending' } : task;
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
      const providerId = providerRequestId(message.params);
      if (task.dispatchState === 'sent' && update?.sessionUpdate === 'user_message_chunk' &&
          message.params._meta?.['codebuddy.ai']?.mode !== 'history' && userText(message.params) === task.prompt &&
          typeof providerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(providerId) && !task.providerRequestId) {
        await this.patch(id, { providerRequestId: providerId });
      }
      // session/load replays old conversation chunks. Capture only this prompt's live output.
      if (task.dispatchState === 'sent' && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' &&
          message.params._meta?.['codebuddy.ai']?.mode !== 'history' &&
          (!task.providerRequestId || !providerId || providerId === task.providerRequestId)) {
        if (typeof update.content.text !== 'string') return;
        if (Buffer.byteLength((task.answer || '') + update.content.text) > 512 * 1024) throw new Error('Cloud output exceeds journal limit');
        await this.patch(id, { answer: (task.answer || '') + update.content.text,
          ...(task.permission ? {} : { output: (task.answer || '') + update.content.text }) });
      }
    } else if (message.method === 'session/endTurn' && task.dispatchState === 'sent' &&
        task.providerRequestId && providerRequestId(message.params) === task.providerRequestId &&
        message.params._meta?.['codebuddy.ai']?.mode !== 'history' && typeof message.params.stopReason === 'string') {
      await this.patch(id, { providerCompletionSignal: 'session/endTurn' });
      this.clients.get(id)?.resolveNotificationResponse(task.promptRequestId, { stopReason: message.params.stopReason });
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

  async dispatch(id, { resumeCreated = false } = {}) {
    let mayHaveExecuted = resumeCreated, client, newlyCreated = resumeCreated, stage = 'preflight';
    let businessPromptAttempted = false;
    try {
      let task = await this.get(id);
      if (!task.remoteTaskId) {
        // Preflight authorization before crossing the non-repeatable creation boundary.
        await this.api.list({ page: 1, size: 1, signal: this.controller.signal });
        await this.patch(id, { dispatchState: 'creating', cloudName: `A2A-${id}` });
        stage = 'create';
        mayHaveExecuted = true;
        const created = await this.api.create({ name: `A2A-${id}`, prompt: bootstrap }, this.controller.signal);
        task = await this.patch(id, { remoteTaskId: created.task_id, dispatchState: 'created' });
        newlyCreated = true;
      }
      stage = 'ready';
      let credentials = await this.api.ready(task.remoteTaskId, { signal: this.controller.signal, newlyCreated,
        onStatus: async status => {
          const current = await this.get(id);
          if (current.providerState !== status) await this.patch(id, { providerState: status });
        } });
      for (let attempt = 0; attempt < 2; attempt++) {
        client = this.clientFactory({ signal: this.controller.signal, onEvent: event => this.event(id, event) });
        this.clients.set(id, client);
        try {
          stage = 'connect'; await client.connect(credentials);
          stage = 'load'; await client.load(task.remoteTaskId, this.cwd); break;
        }
        catch (error) {
          await client.close();
          if (error.status !== 401 || attempt !== 0) throw error;
          credentials = await this.api.get(task.remoteTaskId, this.controller.signal);
        }
      }
      // Durable write comes before POST. Recovery never automatically repeats this RPC.
      const promptRequestId = client.allocateRequestId();
      await this.patch(id, { dispatchState: 'sent', state: 'TASK_STATE_WORKING', promptRequestId,
        businessPromptAttempted: true, answer: '', output: '' });
      mayHaveExecuted = true;
      businessPromptAttempted = true; stage = 'prompt';
      const result = await client.request('session/prompt', { sessionId: task.remoteTaskId,
        prompt: [{ type: 'text', text: task.prompt }] }, { id: promptRequestId, timeoutMs: this.resultTimeoutMs });
      task = await this.get(id);
      const state = endState(result.stopReason);
      await this.patch(id, { state, dispatchState: 'sent', stopReason: result.stopReason,
        permission: undefined, output: task.answer || (state === 'TASK_STATE_COMPLETED' ? 'Cloud turn completed without text output.' : `Cloud turn ended: ${result.stopReason || 'unknown'}. Inspect it before continuing.`) });
    } catch (error) {
      const reason = { preflight: 'cloud_preflight_failed', create: 'cloud_creation_uncertain',
        ready: 'cloud_session_not_ready', connect: 'cloud_acp_connect_failed',
        load: 'cloud_acp_load_failed', prompt: 'cloud_prompt_outcome_unknown' }[stage];
      await this.patch(id, { state: mayHaveExecuted ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_FAILED',
        dispatchState: mayHaveExecuted ? 'unknown' : 'not-sent', permission: undefined,
        failureStage: stage, blockedReason: reason, businessPromptAttempted,
        output: mayHaveExecuted ? `Cloud ${stage} failed (${reason}). ` +
          (businessPromptAttempted ? 'Business prompt outcome requires verification. ' : 'The business prompt was not sent. ') +
          'Inspect the original cloud session; no creation or prompt was repeated.' : error.message });
    } finally {
      this.clients.delete(id); await client?.close();
      if (recoverable(await this.get(id))) this.scheduleRecovery(id, this.recoveryIntervalMs);
    }
  }

  async resume(id) {
    const eligible = task => task?.mode === 'cloud' && task.state === 'TASK_STATE_INPUT_REQUIRED' &&
      task.dispatchState === 'unknown' && task.promptRequestId === undefined &&
      task.businessPromptAttempted !== true && task.remoteTaskId && !task.sharedCloudSession &&
      task.cloudName === `A2A-${id}`;
    const prior = await this.get(id);
    if (!eligible(prior) || this.clients.has(id)) {
      throw new BridgeError(-32002, 'Only a newly created cloud task with no attempted business prompt can be resumed');
    }
    const remote = await this.api.get(prior.remoteTaskId, this.controller.signal);
    if (remote.name !== prior.cloudName || ['failed', 'archived', 'deleted', 'pending'].includes(remote.status)) {
      throw new BridgeError(-32002, 'Original cloud session is unavailable or requires user input; inspect it before resuming');
    }
    const task = await this.store.transact(tasks => {
      const current = tasks.find(value => value.id === id);
      if (!eligible(current) || this.clients.has(id) || current.remoteTaskId !== remote.task_id ||
          tasks.some(value => value.id !== id && !terminal(value))) {
        throw new BridgeError(-32002, 'Cloud task changed or another turn is unresolved; resume was not started');
      }
      Object.assign(current, { state: 'TASK_STATE_WORKING', dispatchState: 'created',
        failureStage: undefined, blockedReason: undefined, businessPromptAttempted: false,
        output: 'Resuming the original cloud session before its first business prompt.', updatedAt: now() });
      return current;
    });
    const operation = this.dispatch(id, { resumeCreated: true });
    this.operations.add(operation);
    operation.catch(() => {}).finally(() => this.operations.delete(operation));
    return task;
  }

  async reconcile(id) {
    if (this.reconciliations.has(id)) return this.reconciliations.get(id);
    const operation = this.reconcileOriginal(id);
    this.reconciliations.set(id, operation);
    this.operations.add(operation);
    operation.finally(() => {
      this.reconciliations.delete(id); this.operations.delete(operation);
    }).catch(() => {});
    return operation;
  }

  async reconcileOriginal(id) {
    const task = await this.get(id);
    if (!recoverable(task) || this.clients.has(id)) {
      throw new BridgeError(-32002, 'Only an unresolved prompted task in its own original cloud session can be reconciled');
    }
    const credentials = await this.api.get(task.remoteTaskId, this.controller.signal);
    if (credentials.name !== task.cloudName) throw new BridgeError(-32002, 'Original cloud session name does not match');
    if (this.api.artifacts) {
      try {
        const artifacts = await this.api.artifacts(task.remoteTaskId, { credentials, signal: this.controller.signal });
        await this.store.transact(tasks => {
          const current = tasks.find(value => value.id === id);
          if (recoverable(current) && current.remoteTaskId === task.remoteTaskId) Object.assign(current, {
            artifacts, artifactRecoveryState: artifacts.length ? 'recovered' : 'empty', providerState: credentials.status });
        });
      } catch {
        // Optional artifact recovery must not prevent ACP history recovery or leak upstream URLs.
      }
    }
    const users = [], endings = [], answers = [];
    const client = this.clientFactory({ signal: this.controller.signal, onEvent: async message => {
      const params = message.params;
      if (params?.sessionId !== task.remoteTaskId) return;
      const requestId = providerRequestId(params);
      if (typeof requestId !== 'string') return;
      if (message.method === 'session/update' && params.update?.sessionUpdate === 'user_message_chunk' &&
          userText(params) === task.prompt && Date.parse(params._meta?.timestamp) >= Date.parse(task.createdAt)) users.push(requestId);
      if (message.method === 'session/update' && params.update?.sessionUpdate === 'agent_message_chunk' &&
          typeof params.update.content?.text === 'string') {
        if (answers.reduce((size, item) => size + Buffer.byteLength(item.text), 0) + Buffer.byteLength(params.update.content.text) > 512 * 1024) {
          throw new Error('Cloud replay exceeds journal limit');
        }
        answers.push({ requestId, text: params.update.content.text });
      }
      if (message.method === 'session/endTurn' && typeof params.stopReason === 'string') endings.push({ requestId, stopReason: params.stopReason });
    } });
    this.clients.set(id, client);
    try { await client.connect(credentials); await client.load(task.remoteTaskId, this.cwd); }
    finally { this.clients.delete(id); await client.close(); }
    if (users.length !== 1 || (task.providerRequestId && task.providerRequestId !== users[0])) {
      throw new BridgeError(-32002, 'Original prompt cannot be uniquely matched to a provider turn; result remains unresolved');
    }
    const matchingEnds = endings.filter(ending => ending.requestId === users[0]);
    const output = answers.filter(answer => answer.requestId === users[0]).map(answer => answer.text).join('');
    const stopReasons = [...new Set(matchingEnds.map(ending => ending.stopReason))];
    await this.store.transact(tasks => {
      const current = tasks.find(value => value.id === id);
      if (!recoverable(current) || current.promptRequestId !== task.promptRequestId || current.remoteTaskId !== task.remoteTaskId) return;
      const recoveredText = 'Recovered original cloud output; completion remains unverified.\n\n' + output;
      if (output.trim() && current.output !== recoveredText) current.updatedAt = now();
      Object.assign(current, { providerState: credentials.status, providerRequestId: users[0],
        recoveryEndTurnCount: matchingEnds.length, completionVerified: false,
        recoveryBlockedReason: stopReasons.length > 1 ? 'conflicting_end_turn' : matchingEnds.length ? 'unconfirmed_stop_reason' : 'missing_end_turn',
        ...(output.trim() ? { recoveredOutput: true, recoveryState: 'output_recovered',
          output: recoveredText } : {}) });
    });
    if (stopReasons.length !== 1 || endState(stopReasons[0]) === 'TASK_STATE_INPUT_REQUIRED') {
      throw new BridgeError(-32002, `No unique authoritative endTurn exists for the original prompt (matched=${matchingEnds.length}, distinctReasons=${stopReasons.length}); result remains unresolved`);
    }
    if (endState(stopReasons[0]) === 'TASK_STATE_COMPLETED' && !output.trim()) {
      throw new BridgeError(-32002, 'No correlated result text was recovered; result remains unresolved');
    }
    return this.store.transact(tasks => {
      const current = tasks.find(value => value.id === id);
      if (current?.state !== 'TASK_STATE_INPUT_REQUIRED' || current.dispatchState !== 'unknown' ||
          current.promptRequestId !== task.promptRequestId || current.remoteTaskId !== task.remoteTaskId) {
        throw new BridgeError(-32002, 'Cloud task changed during reconciliation');
      }
      Object.assign(current, { state: endState(stopReasons[0]), dispatchState: 'sent',
        stopReason: stopReasons[0], providerRequestId: users[0],
        providerCompletionSignal: 'reconciled_session/endTurn', failureStage: undefined, blockedReason: undefined,
        recoveryState: 'verified', recoveryLastAttemptAt: now(), completionVerified: true, recoveryBlockedReason: undefined, output,
        updatedAt: now() });
      return current;
    });
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
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    await Promise.allSettled(this.operations);
  }
}
