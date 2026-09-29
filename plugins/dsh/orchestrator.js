import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';
import { ConversationStore } from './store.js';

const FINAL = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);
const PAUSED = new Set([TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]);

function assertUrl(value, allowHttp) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('A2A URLs cannot contain credentials or fragments');
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new Error(`A2A endpoint ${url.origin} requires HTTPS (or explicit allowHttp)`);
  }
  return url;
}

function partKey(part) {
  if (!part) return '';
  if (part.content?.$case) {
    const { $case, value } = part.content;
    if ($case === 'text' || $case === 'url') return `${$case}:${value ?? ''}`;
    if ($case === 'data') return `data:${JSON.stringify(value)}`;
    if ($case === 'raw') {
      const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
        ? Buffer.from(value).toString('base64')
        : String(value ?? '');
      return `raw:${bytes}`;
    }
  }
  if (typeof part.text === 'string') return `text:${part.text}`;
  return JSON.stringify(part);
}

export function responseParts(response) {
  if ('parts' in response) return response.parts ?? [];
  const task = response;
  const parts = [];
  const initial = task.status?.message?.parts?.length
    ? task.status.message.parts
    : (task.status?.message?.parts ?? []);
  if (initial.length > 0) {
    parts.push(...initial);
  } else {
    const lastReply = [...(task.history ?? [])].reverse().find(message => message.role === Role.ROLE_AGENT);
    if (lastReply?.parts) parts.push(...lastReply.parts);
  }
  const seen = new Set(parts.map(partKey).filter(Boolean));
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      const key = partKey(part);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      parts.push(part);
    }
  }
  return parts;
}

function toContent(response) {
  return responseParts(response).map(part => {
    switch (part.content?.$case) {
      case 'text': return { type: 'text', text: part.content.value };
      case 'data': return { type: 'text', text: JSON.stringify(part.content.value) };
      case 'url': return { type: 'text', text: part.content.value };
      case 'raw': return { type: 'text', text: `[binary ${part.mediaType || 'application/octet-stream'} part; inspect the A2A task for bytes]` };
      default:
        if (typeof part?.text === 'string') return { type: 'text', text: part.text };
        return { type: 'text', text: '[unsupported A2A part; inspect the A2A task]' };
    }
  });
}

function fromContent(content) {
  if (!Array.isArray(content) || content.length === 0 || content.some(part => part.type !== 'text')) {
    throw new Error('A2A delegation currently accepts non-empty text content only');
  }
  return content.map(part => ({ content: { $case: 'text', value: part.text }, metadata: undefined,
    filename: '', mediaType: 'text/plain' }));
}

class RelayAuthError extends Error {}

function safeDiagnostic(error) {
  if (error instanceof RelayAuthError) return error.message;
  if (error?.name === 'AbortError') return 'A2A request cancelled';
  // SDK errors may contain response bodies, which can contain credentials or task data.
  return 'A2A remote transport or protocol error';
}

/** DSH's remote A2A registry and durable conversation control surface. */
export class A2AOrchestrator {
  constructor(config, { fetchImpl = fetch, store } = {}) {
    if (!Array.isArray(config.agents) || config.agents.length === 0) throw new Error('configure at least one A2A agent');
    this.agents = new Map();
    this.clients = new Map();
    this.store = store ?? new ConversationStore(config.storePath);
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
    for (const agent of config.agents) {
      if (!agent.id || this.agents.has(agent.id)) throw new Error(`duplicate or empty A2A agent id: ${agent.id}`);
      if (Boolean(agent.url) === Boolean(agent.card)) {
        throw new Error(`agent ${agent.id} requires exactly one of url or card`);
      }
      const cardUrl = agent.card ? assertUrl(agent.card, agent.allowHttp) : undefined;
      const base = assertUrl(agent.url ?? cardUrl.origin, agent.allowHttp);
      const cardPath = cardUrl ? `${cardUrl.pathname}${cardUrl.search}` : agent.cardPath;
      const allowed = new Set([base.origin, ...(agent.allowedOrigins ?? []).map(url => assertUrl(url, agent.allowHttp).origin)]);
      const scopedFetch = async (input, init = {}) => {
        const target = assertUrl(input instanceof Request ? input.url : String(input), agent.allowHttp);
        if (!allowed.has(target.origin)) throw new Error(`A2A endpoint origin ${target.origin} is not allowed`);
        const headers = new Headers(init.headers);
        let secret;
        // Re-read on each request so pairing/rotation works without restarting DSH.
        const relayCard = cardUrl ?? new URL(cardPath || '/.well-known/agent-card.json', base);
        if (relayCard.pathname.startsWith('/agents/')) {
          const path = config.connectorState || join(homedir(), '.config', 'a2a-connector', 'dsh.json');
          let enrollment;
          try { enrollment = JSON.parse(await readFile(path, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read DSH Connector pairing state'); }
          if (enrollment) {
            const pairedCard = assertUrl(enrollment.card, agent.allowHttp);
            if (pairedCard.origin !== base.origin || target.origin !== pairedCard.origin) {
              throw new Error('DSH Connector pairing belongs to another Relay');
            }
            if (!enrollment.agentId || typeof enrollment.token !== 'string' ||
                !enrollment.token.startsWith(`agt_${enrollment.agentId}.`)) {
              throw new Error('Invalid DSH Connector pairing state');
            }
            secret = enrollment.token;
          }
        }
        secret ||= agent.tokenEnv ? process.env[agent.tokenEnv] : undefined;
        if (agent.tokenEnv && !secret) throw new Error(`A2A credential environment variable ${agent.tokenEnv} is missing`);
        if (secret) headers.set('Authorization', `Bearer ${secret}`);
        const apiKey = agent.apiKeyEnv ? process.env[agent.apiKeyEnv] : undefined;
        if (agent.apiKeyEnv && !apiKey) throw new Error(`A2A credential environment variable ${agent.apiKeyEnv} is missing`);
        if (apiKey) headers.set(agent.apiKeyHeader || 'X-API-Key', apiKey);
        const timeout = AbortSignal.timeout(this.requestTimeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        const response = await fetchImpl(input, { ...init, headers, redirect: 'manual', signal });
        if ([401, 403].includes(response.status) && relayCard.pathname.startsWith('/agents/') && target.origin === base.origin) {
          let body;
          try { body = await response.json(); } catch { /* older Relay may return no JSON */ }
          if (body?.error === 'access_denied') {
            const id = typeof body.agentId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.agentId)
              ? ` (${body.agentId})` : '';
            throw new RelayAuthError(`Relay access_denied${id}: 当前主控没有调用该目标的权限；请管理员在 ${base.origin}/pair/list 授权目标 Agent。`);
          }
          if (body?.error === 'not_controller') {
            const id = typeof body.agentId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.agentId)
              ? ` (${body.agentId})` : '';
            throw new RelayAuthError(`Relay not_controller${id}: 已配对但未设为主控；请管理员在 ${base.origin}/pair/list 将本机 DSH Agent 设为主控。`);
          }
          throw new RelayAuthError('Relay unauthorized (401): 检查本机 Connector 配对状态、凭据是否已轮换及 connectorState 路径；旧版 Relay 还需检查 /pair/list 主控设置。');
        }
        return response;
      };
      const resolver = new DefaultAgentCardResolver({ fetchImpl: scopedFetch });
      const factory = new ClientFactory({
        cardResolver: resolver,
        preferredTransports: ['JSONRPC', 'HTTP+JSON'],
        transports: [new JsonRpcTransportFactory({ fetchImpl: scopedFetch }), new RestTransportFactory({ fetchImpl: scopedFetch })],
        clientConfig: { polling: true, acceptedOutputModes: ['text/plain', 'application/json'] },
      });
      this.agents.set(agent.id, { ...agent, url: base.href, cardPath, base, resolver, factory, allowed });
    }
  }

  configuredAgents() {
    return [...this.agents.values()].map(agent => ({ id: agent.id, url: agent.url }));
  }

  async discover(id, { refresh = false } = {}) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown A2A agent: ${id}`);
    if (!refresh && this.clients.has(id)) return this.clients.get(id).card;
    const card = await agent.resolver.resolve(agent.url, agent.cardPath);
    if (!card.name || !Array.isArray(card.supportedInterfaces)) throw new Error(`invalid A2A Agent Card for ${id}`);
    const interfaces = card.supportedInterfaces.filter(item =>
      item.protocolVersion === '1.0' && ['JSONRPC', 'HTTP+JSON'].includes(item.protocolBinding) &&
      agent.allowed.has(assertUrl(item.url, agent.allowHttp).origin));
    if (interfaces.length === 0) throw new Error(`agent ${id} offers no allowed A2A v1.0 JSONRPC or HTTP+JSON interface`);
    if (card.capabilities?.extensions?.some(extension => extension.required)) {
      throw new Error(`agent ${id} requires an unsupported A2A extension`);
    }
    const selected = { ...card, supportedInterfaces: interfaces };
    const client = await agent.factory.createFromAgentCard(selected);
    this.clients.set(id, { card: selected, client });
    return selected;
  }

  async client(id) {
    await this.discover(id);
    return this.clients.get(id).client;
  }

  async listAgents({ refresh = false } = {}) {
    return Promise.all(this.configuredAgents().map(async ({ id }) => {
      const configured = this.agents.get(id);
      const guidance = {
        ...(configured.purpose ? { purpose: configured.purpose } : {}),
        ...(configured.whenToUse ? { whenToUse: configured.whenToUse } : {}),
        ...(configured.notFor ? { notFor: configured.notFor } : {}),
      };
      try {
        const card = await this.discover(id, { refresh });
        return { id, ...guidance, name: card.name, description: card.description, skills: card.skills,
          inputModes: card.defaultInputModes, outputModes: card.defaultOutputModes, available: true };
      } catch (error) {
        return { id, ...guidance, available: false, diagnostic: safeDiagnostic(error) };
      }
    }));
  }

  async send({ agentId, parentId, content, conversationId, signal }) {
    if (!parentId) throw new Error('A2A conversation requires a parent session id');
    let previous = conversationId ? await this.owned(conversationId, parentId) : undefined;
    if (previous && previous.agentId !== agentId) throw new Error('A2A conversation belongs to another agent');
    if (previous?.taskId && !FINAL.has(previous.state)) {
      await this.getTask(previous.id, parentId, { signal });
      previous = await this.owned(previous.id, parentId);
    }
    const client = await this.client(agentId);
    const message = {
      messageId: randomUUID(), contextId: previous?.contextId ?? '',
      taskId: previous && PAUSED.has(previous.state) ? previous.taskId ?? '' : '',
      role: Role.ROLE_USER, parts: fromContent(content), metadata: undefined,
      extensions: [], referenceTaskIds: [],
    };
    const response = await client.sendMessage({ tenant: '', message, metadata: undefined,
      configuration: { acceptedOutputModes: ['text/plain', 'application/json'],
        taskPushNotificationConfig: undefined, returnImmediately: true } }, { signal });
    const isTask = 'status' in response;
    const record = {
      id: previous?.id ?? randomUUID(), parentId, agentId,
      contextId: response.contextId || previous?.contextId || '',
      taskId: isTask ? response.id : previous?.taskId ?? '',
      state: isTask ? response.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED : TaskState.TASK_STATE_COMPLETED,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.store.put(record);
    } catch (error) {
      if (isTask && !FINAL.has(record.state)) {
        await client.cancelTask({ tenant: '', id: response.id, metadata: undefined }).catch(() => {});
      }
      throw error;
    }
    return { conversation: record, response };
  }

  async owned(id, parentId) {
    const record = await this.store.get(id);
    if (!record || record.parentId !== parentId) throw new Error('A2A conversation not found');
    return record;
  }

  async listConversations(parentId) {
    return this.store.list(parentId);
  }

  async getTask(id, parentId, { signal } = {}) {
    const record = await this.owned(id, parentId);
    if (!record.taskId) throw new Error('A2A conversation has no task');
    const task = await (await this.client(record.agentId)).getTask({ tenant: '', id: record.taskId }, { signal });
    await this.store.put({ ...record, state: task.status?.state ?? record.state, updatedAt: new Date().toISOString() });
    return task;
  }

  async listRemoteTasks(agentId, { contextId = '', pageSize = 50, pageToken = '', signal } = {}) {
    return (await this.client(agentId)).listTasks({ tenant: '', contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED, pageSize, pageToken,
      statusTimestampAfter: undefined }, { signal });
  }

  async cancel(id, parentId, { signal } = {}) {
    const record = await this.owned(id, parentId);
    if (!record.taskId || FINAL.has(record.state)) return { cancelled: false, state: record.state };
    const task = await (await this.client(record.agentId)).cancelTask({ tenant: '', id: record.taskId,
      metadata: undefined }, { signal });
    await this.store.put({ ...record, state: task.status?.state ?? record.state, updatedAt: new Date().toISOString() });
    return { cancelled: true, state: task.status?.state, task };
  }

  async waitForResult(conversation, initial, signal) {
    let current = initial;
    while ('status' in current && !FINAL.has(current.status?.state) && !PAUSED.has(current.status?.state)) {
      if (signal?.aborted) {
        try { await this.cancel(conversation.id, conversation.parentId); } catch { /* best effort; cancellation is observable via getTask */ }
        return { output: [], stopReason: 'aborted' };
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
      try { current = await this.getTask(conversation.id, conversation.parentId, { signal }); }
      catch (error) {
        if (signal?.aborted) {
          try { await this.cancel(conversation.id, conversation.parentId); } catch { /* best effort */ }
          return { output: [], stopReason: 'aborted' };
        }
        return { output: [], stopReason: 'error', diagnostic: safeDiagnostic(error) };
      }
    }
    const state = 'status' in current ? current.status?.state : TaskState.TASK_STATE_COMPLETED;
    const stopReason = state === TaskState.TASK_STATE_COMPLETED ? 'completed'
      : state === TaskState.TASK_STATE_CANCELED ? 'aborted'
      : state === TaskState.TASK_STATE_REJECTED ? 'refusal'
      : PAUSED.has(state) ? 'completed' : 'error';
    return { output: toContent(current), stopReason,
      ...(stopReason === 'error' ? { diagnostic: 'A2A task failed' } : {}) };
  }

  async startRun(agentId, request) {
    const parentId = request.parent?.session?.id;
    if (!parentId) throw new Error('A2A subagent requires a parent session');
    const { conversation, response } = await this.send({ agentId, parentId,
      content: request.prompt, signal: request.signal });
    if (request.signal.aborted) {
      await this.cancel(conversation.id, parentId).catch(() => {});
      throw new Error('A2A start cancelled');
    }
    let disposed = false;
    const lifetime = new AbortController();
    const onAbort = () => lifetime.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) lifetime.abort();
    const result = this.waitForResult(conversation, response, lifetime.signal)
      .then(outcome => ({ ...outcome, output: [...outcome.output,
        { type: 'text', text: `A2A conversation ID: ${conversation.id}` }] }))
      .finally(() => request.signal.removeEventListener('abort', onAbort));
    return {
      id: conversation.id, localAgent: undefined, result,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        const state = (await this.owned(conversation.id, parentId)).state;
        if (!FINAL.has(state) && !PAUSED.has(state)) {
          await this.cancel(conversation.id, parentId).catch(() => {});
        }
        await result;
      },
    };
  }
}

export const a2aTaskState = TaskState;
