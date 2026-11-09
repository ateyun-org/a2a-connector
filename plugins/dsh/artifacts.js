import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_ARTIFACT_BYTES = 512 * 1024;

export function artifactLimit(maxBytes, outputPath) {
  if (outputPath !== undefined && (typeof outputPath !== 'string' || !isAbsolute(outputPath) || outputPath.includes('\0'))) {
    throw new Error('A2A artifact output_path must be an absolute local file path');
  }
  const limit = outputPath === undefined ? MAX_INLINE_ARTIFACT_BYTES : MAX_ARTIFACT_BYTES;
  maxBytes ??= limit;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limit) {
    throw new Error(`A2A artifact max_bytes must be an integer from 1 to ${limit}${outputPath === undefined ? '; use output_path for larger files' : ''}`);
  }
  return maxBytes;
}

export function validArtifactId(value) {
  return typeof value === 'string' && value.startsWith('agent:///') && value.length <= 2048 &&
    !/[%\\?#\x00-\x1f\x7f]/.test(value) &&
    value.slice('agent:///'.length).split('/').every(part => part && part !== '.' && part !== '..');
}

function rpcError(value) {
  // Upstream messages/data may contain credentials, signed URLs or file contents.
  const code = Number.isSafeInteger(value?.code) ? value.code : 'unknown';
  const reasons = ['relay_artifact_expired_or_missing', 'relay_artifact_integrity_failed',
    'relay_artifact_unavailable', 'artifact_exceeds_byte_limit'];
  const stages = ['artifact_list', 'artifact_lookup', 'artifact_download'];
  const data = value?.data;
  const detail = [reasons.includes(data?.reason) ? `reason=${data.reason}` : '',
    stages.includes(data?.stage) ? `stage=${data.stage}` : '',
    typeof data?.retryable === 'boolean' ? `retryable=${data.retryable}` : ''].filter(Boolean);
  return new Error(`A2A GetArtifact failed: RPC ${code}${detail.length ? '; ' + detail.join('; ') : ''}`);
}

/** Bound the encoded response, then verify the exact registered file bytes. */
export async function readArtifact(response, requestId, artifactId, maxBytes) {
  const maxResponseBytes = Math.ceil(maxBytes / 3) * 4 + 64 * 1024;
  if (!response.ok || Number(response.headers.get('content-length')) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.ok ? 'A2A GetArtifact response exceeds byte limit' : `A2A GetArtifact HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('A2A GetArtifact returned no response body');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxResponseBytes) throw new Error('A2A GetArtifact response exceeds byte limit');
      chunks.push(chunk);
    }
  } catch (error) {
    if (size > maxResponseBytes) throw error;
    throw new Error('A2A GetArtifact response read failed or was cancelled');
  }
  let reply;
  try { reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('A2A GetArtifact returned invalid JSON'); }
  if (reply?.jsonrpc !== '2.0' || reply.id !== requestId ||
      (Object.hasOwn(reply, 'result') && Object.hasOwn(reply, 'error'))) {
    throw new Error('A2A GetArtifact returned an invalid RPC envelope');
  }
  if (reply.error) throw rpcError(reply.error);
  const artifact = reply.result?.artifact;
  const part = artifact?.parts?.[0];
  const metadata = artifact?.metadata;
  if (artifact?.artifactId !== artifactId || !Array.isArray(artifact.parts) || artifact.parts.length !== 1 ||
      typeof part?.raw !== 'string' || part.raw.length > Math.ceil(maxBytes / 3) * 4 ||
      part.text !== undefined || part.url !== undefined ||
      !Number.isSafeInteger(metadata?.sizeBytes) || metadata.sizeBytes < 0 || metadata.sizeBytes > maxBytes ||
      !/^[a-f0-9]{64}$/.test(metadata?.sha256 || '') || metadata.contentAvailability === 'reference_only') {
    throw new Error('A2A GetArtifact returned invalid or oversized file contents');
  }
  const bytes = Buffer.from(part.raw, 'base64');
  if (bytes.toString('base64') !== part.raw || bytes.length !== metadata.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) {
    throw new Error('A2A artifact integrity check failed');
  }
  return { artifact, bytes };
}

/** Return small files inline, or save verified bytes privately without overwriting. */
export async function deliverArtifact({ artifact, bytes }, { outputPath, signal } = {}) {
  if (signal?.aborted) throw new Error('A2A artifact request cancelled');
  const part = artifact.parts[0];
  const metadata = { sizeBytes: bytes.length, sha256: artifact.metadata.sha256 };
  if (artifact.metadata.downloadSource === 'relay_temp') metadata.downloadSource = 'relay_temp';
  if (Number.isFinite(Date.parse(artifact.metadata.expiresAt))) metadata.expiresAt = artifact.metadata.expiresAt;
  const result = { artifactId: artifact.artifactId, filename: part.filename || artifact.name,
    mediaType: part.mediaType || 'application/octet-stream', metadata };
  if (outputPath !== undefined) {
    const file = await open(outputPath, 'wx', 0o600);
    try {
      await file.writeFile(bytes, { signal });
      await file.close();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(outputPath).catch(() => {});
      throw error;
    }
    return { ...result, path: outputPath };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes('\0')) return { ...result, encoding: 'utf-8', text };
  } catch { /* Binary content is returned as exact Base64, not lossy UTF-8. */ }
  return { ...result, encoding: 'base64', raw: part.raw };
}
