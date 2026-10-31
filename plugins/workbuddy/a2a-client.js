import { createHash, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

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
    headers: { authorization: `Bearer ${token}`, ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    signal: AbortSignal.timeout(30000) }));
}

function taskFrom(result) {
  return result?.task ?? (result?.id && result?.status ? result : null);
}

function resultText(result) {
  const message = result?.status?.message ?? result?.message;
  return (message?.parts ?? []).filter(part => typeof part?.text === 'string').map(part => part.text).join('\n');
}

async function openRPC({ relay, allowInsecure = false, enrollment, targetId, relayRequestId }) {
  if (!agentIdPattern.test(targetId)) throw new Error('invalid target Agent ID');
  if (!enrollment?.token || !enrollment?.agentId) throw new Error('paired WorkBuddy credential is required');
  const origin = relayOrigin(relay, allowInsecure);
  const cardURL = new URL(`/agents/${targetId}/.well-known/agent-card.json`, origin);
  const card = await request(cardURL, enrollment.token);
  const endpoint = endpointFromCard(card, origin, targetId);
  let id = 0;
  return async (method, params) => {
    const reply = await request(endpoint, enrollment.token, { method: 'POST',
      ...(method === 'SendMessage' && relayRequestId ? { headers: { 'X-Relay-Request-Id': relayRequestId } } : {}),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (reply?.error) {
      let summary = '';
      const data = reply.error.data;
      if (method === 'GetArtifact' && data && ['artifact_list', 'artifact_lookup', 'artifact_download'].includes(data.stage)) {
        const reasons = new Set(['http_status', 'authentication_required', 'ticket_expired', 'redirect_blocked', 'request_failed', 'timeout', 'canceled', 'address_blocked', 'invalid_request', 'invalid_response', 'not_found', 'untrusted_url', 'size_limit', 'body_read_failed']);
        const rejections = new Set(['data_origin_missing', 'invalid_data_origin', 'invalid_acp_origin', 'acp_origin_not_sandbox', 'data_scheme_not_https', 'data_port_not_https', 'data_host_not_envd', 'sandbox_id_mismatch', 'sandbox_region_mismatch', 'sandbox_family_mismatch', 'data_userinfo_not_allowed', 'data_query_not_supported', 'data_fragment_not_allowed', 'data_path_not_supported']);
        const attempts = (Array.isArray(data.attempts) ? data.attempts : []).slice(0, 3)
          .filter(attempt => ['entry_url', 'sandbox_data', 'sandbox_path', 'artifact_list'].includes(attempt?.source))
          .map(attempt => `${attempt.source}=${Number.isInteger(attempt.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599 ? `HTTP_${attempt.httpStatus}` : reasons.has(attempt.reason) ? attempt.reason : 'unavailable'}${rejections.has(attempt.rejection) ? `(${attempt.rejection})` : ''}`);
        summary = `; stage=${data.stage}${attempts.length ? '; ' + attempts.join('; ') : ''}${typeof data.retryable === 'boolean' ? `; retryable=${data.retryable}` : ''}`;
      }
      const error = new Error(`A2A ${method} failed: ${reply.error.message || reply.error.code}${summary}`);
      error.code = reply.error.code;
      error.data = data;
      throw error;
    }
    if (!reply || !('result' in reply)) throw new Error(`A2A ${method} returned no result`);
    return reply.result;
  };
}

export async function listTargets({ relay, allowInsecure = false, enrollment }) {
  if (!enrollment?.token) throw new Error('paired WorkBuddy credential is required');
  const result = await request(new URL('/pairing/targets', relayOrigin(relay, allowInsecure)), enrollment.token);
  if (!Array.isArray(result.targets) || result.targets.some(target => !agentIdPattern.test(target?.agentId || ''))) {
    throw new Error('Relay returned an invalid target list');
  }
  return result;
}

function presentTask(targetId, task) {
  return { targetId, taskId: task.id, contextId: task.contextId,
    state: task.status?.state || 'UNKNOWN', text: resultText(task),
    ...(task.metadata ? { metadata: task.metadata } : {}), ...(task.artifacts ? { artifacts: task.artifacts } : {}) };
}

export async function controlAgentTask(options, method, params) {
  if (!['RespondPermission', 'CancelTask', 'ReleaseCloudTask', 'ResumeCloudTask', 'ReconcileCloudTask'].includes(method)) throw new Error('Unsupported task control method');
  const rpc = await openRPC(options);
  const task = taskFrom(await rpc(method, params));
  if (!task) throw new Error('A2A task control returned no task');
  return presentTask(options.targetId, task);
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

/** Query only the original task's sanitized server-side diagnostic view. */
export async function getAgentDiagnostics(options, taskId) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 255 || /[\u0000-\u001f\u007f]/.test(taskId)) throw new Error('invalid task ID');
  const rpc = await openRPC(options);
  const result = await rpc('GetTaskDiagnostics', { id: taskId });
  if (result?.taskId !== taskId || result.diagnostics?.version !== 'diagnostics-v1' ||
      !['recorded', 'not_recorded'].includes(result.diagnostics.executionCapture) ||
      typeof result.upstreamRefresh?.attempted !== 'boolean' || typeof result.upstreamRefresh?.succeeded !== 'boolean') {
    throw new Error('A2A GetTaskDiagnostics returned an invalid diagnostic view');
  }
  return result;
}

export function validArtifactURI(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('agent:///') || uri.length > 2048 || /[\u0000-\u001f\u007f%\\?#]/.test(uri)) return false;
  return uri.slice('agent:///'.length).split('/').every(part => part && part !== '.' && part !== '..');
}

/** Read an existing registered artifact without submitting or releasing a task. */
export async function getAgentArtifact(options, taskId, artifactId) {
  if (typeof taskId !== 'string' || !taskId || taskId.length > 255 || /[\u0000-\u001f\u007f]/.test(taskId)) throw new Error('invalid task ID');
  if (!validArtifactURI(artifactId)) throw new Error('invalid artifact URI');
  const rpc = await openRPC(options);
  const result = await rpc('GetArtifact', { id: taskId, artifactId });
  const artifact = result?.artifact;
  const part = artifact?.parts?.[0];
  if (artifact?.artifactId !== artifactId || !Array.isArray(artifact.parts) || artifact.parts.length !== 1 ||
      typeof part?.raw !== 'string' || part.text !== undefined || part.url !== undefined ||
      !Number.isSafeInteger(artifact.metadata?.sizeBytes) || artifact.metadata.sizeBytes < 0 || artifact.metadata.sizeBytes > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(artifact.metadata?.sha256 || '')) throw new Error('A2A GetArtifact returned invalid file contents');
  const bytes = Buffer.from(part.raw, 'base64');
  if (bytes.toString('base64') !== part.raw || bytes.length !== artifact.metadata.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.metadata.sha256) throw new Error('A2A artifact integrity check failed');
  return { artifact, bytes };
}

/** Preserve the exact bytes and refuse to overwrite any existing output file. */
export async function downloadAgentArtifact(options, taskId, artifactId, outputPath) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('an explicit --output path is required');
  const destination = resolve(outputPath);
  const { artifact, bytes } = await getAgentArtifact(options, taskId, artifactId);
  const file = await open(destination, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(destination).catch(() => {});
    throw error;
  }
  return { targetId: options.targetId, taskId, artifactId, path: destination,
    sizeBytes: bytes.length, sha256: artifact.metadata.sha256 };
}

export async function listAgentTasks(options, params = {}) {
  const rpc = await openRPC(options);
  const result = await rpc('ListTasks', params);
  if (!Array.isArray(result?.tasks) || typeof result.nextPageToken !== 'string' ||
      !Number.isInteger(result.totalSize) || result.totalSize < 0) throw new Error('A2A ListTasks returned an invalid collection');
  return result;
}

export async function callAgent({ relay, allowInsecure = false, enrollment, targetId, prompt,
  pollIntervalMs = 2000, deadlineMs = 120000, messageId = randomUUID(), contextId, executionMode, relayRequestId, onTask, onDispatch }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('task text is required on stdin');
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 256) throw new Error('invalid message ID');
  if (contextId !== undefined && (typeof contextId !== 'string' || !contextId || contextId.length > 256)) throw new Error('invalid context ID');
  if (executionMode !== undefined && !['cloud', 'desktop'].includes(executionMode)) throw new Error('invalid WorkBuddy execution mode');
  if (relayRequestId !== undefined && !/^[0-9a-f]{32}$/.test(relayRequestId)) throw new Error('invalid Relay request ID');
  const rpc = await openRPC({ relay, allowInsecure, enrollment, targetId, relayRequestId });
  await onDispatch?.();
  let result = await rpc('SendMessage', { message: { messageId, role: 'ROLE_USER',
    ...(contextId ? { contextId } : {}), ...(executionMode ? { metadata: { workbuddyMode: executionMode } } : {}), parts: [{ text: prompt }] } });
  const firstTask = taskFrom(result);
  if (!firstTask) return { targetId, state: 'MESSAGE', text: resultText(result) };
  if (typeof firstTask.id !== 'string' || !firstTask.id) throw new Error('A2A task has no ID');
  await onTask?.(presentTask(targetId, firstTask));
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

/** Recover a late response through the existing Relay journal; never sends a second task. */
export async function recoverDispatch(options, requestId) {
  if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error('invalid Relay request ID');
  const origin = relayOrigin(options.relay, options.allowInsecure);
  const record = await request(new URL(`/relay/requests/${requestId}`, origin), options.enrollment.token);
  if (record.targetAgentId !== options.targetId && record.target !== options.targetId) {
    throw new Error('Relay request journal target does not match');
  }
  if (record.state !== 'completed') return { targetId: options.targetId, state: 'UNKNOWN', text: 'Relay outcome is unresolved; do not resubmit', relayRequestId: requestId };
  let reply;
  try { reply = JSON.parse(record.responseBody); } catch { throw new Error('Relay has no recoverable A2A response'); }
  if (reply.error || !reply.result) throw new Error('Original A2A dispatch returned an error; inspect its outcome before retrying');
  const task = taskFrom(reply.result);
  if (task) return getAgentTask(options, task.id);
  return { targetId: options.targetId, state: 'MESSAGE', text: resultText(reply.result) };
}
