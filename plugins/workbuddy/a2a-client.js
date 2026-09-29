import { randomUUID } from 'node:crypto';

const agentIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const maxResponseBytes = 16 * 1024 * 1024;
const activeStates = new Set(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']);

function relayOrigin(relay, allowInsecure) {
  const url = new URL(relay);
  if (!['wss:', 'ws:'].includes(url.protocol) || url.pathname !== '/connect' ||
      url.search || url.hash || url.username || url.password ||
      (url.protocol === 'ws:' && !allowInsecure)) {
    throw new Error('relay must be a WSS /connect URL');
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  return url;
}

function endpointFromCard(card, origin, targetId) {
  const prefix = `/agents/${targetId}/`;
  for (const entry of card?.supportedInterfaces ?? []) {
    if (entry?.protocolBinding !== 'JSONRPC') continue;
    let url;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.origin === origin.origin && url.pathname.startsWith(prefix) &&
        !url.pathname.includes('%') &&
        !url.username && !url.password && !url.search && !url.hash) return url;
  }
  throw new Error('Agent Card has no JSONRPC endpoint under this Relay target');
}

async function readJSON(response) {
  if (!response.ok) {
    const hint = response.status === 403 ? ' (ask the Relay administrator to grant this Agent access)' : '';
    throw new Error(`Relay request failed: HTTP ${response.status}${hint}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > maxResponseBytes) throw new Error('Relay response is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxResponseBytes) throw new Error('Relay response is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Relay returned invalid JSON'); }
}

async function request(url, token, options = {}) {
  return readJSON(await fetch(url, { ...options, redirect: 'manual',
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30000) }));
}

function taskFrom(result) {
  return result?.task ?? (result?.id && result?.status ? result : null);
}

function resultText(result) {
  const message = result?.status?.message ?? result?.message;
  return (message?.parts ?? []).filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
}

async function openRPC({ relay, allowInsecure = false, enrollment, targetId }) {
  if (!agentIdPattern.test(targetId)) throw new Error('invalid target Agent ID');
  if (!enrollment?.token || !enrollment?.agentId) throw new Error('paired WorkBuddy credential is required');
  const origin = relayOrigin(relay, allowInsecure);
  const cardURL = new URL(`/agents/${targetId}/.well-known/agent-card.json`, origin);
  const card = await request(cardURL, enrollment.token);
  const endpoint = endpointFromCard(card, origin, targetId);
  let id = 0;
  return async (method, params) => {
    const reply = await request(endpoint, enrollment.token, { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (reply?.error) throw new Error(`A2A ${method} failed: ${reply.error.message || reply.error.code}`);
    if (!reply || !('result' in reply)) throw new Error(`A2A ${method} returned no result`);
    return reply.result;
  };
}

function presentTask(targetId, task) {
  return { targetId, taskId: task.id, contextId: task.contextId,
    state: task.status?.state || 'UNKNOWN', text: resultText(task) };
}

export async function getAgentTask(options, taskId) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 256 || /[\u0000-\u001f\u007f]/.test(taskId)) {
    throw new Error('invalid task ID');
  }
  const rpc = await openRPC(options);
  const task = taskFrom(await rpc('GetTask', { id: taskId }));
  if (!task) throw new Error('A2A GetTask returned no task');
  return presentTask(options.targetId, task);
}

export async function callAgent({ relay, allowInsecure = false, enrollment, targetId, prompt,
  pollIntervalMs = 2000, deadlineMs = 120000 }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('task text is required on stdin');
  const rpc = await openRPC({ relay, allowInsecure, enrollment, targetId });
  let result = await rpc('SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER',
    parts: [{ text: prompt }] } });
  const firstTask = taskFrom(result);
  if (!firstTask) return { targetId, state: 'MESSAGE', text: resultText(result) };
  if (typeof firstTask.id !== 'string' || !firstTask.id) throw new Error('A2A task has no ID');
  const expires = Date.now() + deadlineMs;
  let task = firstTask;
  while (activeStates.has(task.status?.state)) {
    if (Date.now() >= expires) throw new Error(`A2A task ${task.id} is still running; check it before retrying`);
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    task = taskFrom(await rpc('GetTask', { id: task.id }));
    if (!task) throw new Error('A2A GetTask returned no task');
  }
  return presentTask(targetId, task);
}
