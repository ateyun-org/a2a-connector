import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installOutbound } from '../../plugins/dsh/outbound.js';

const artifactId = 'agent:///workspace/deliverable.bin';
const parentId = 'artifact-owner';
const execution = { agent: { session: { id: parentId } } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-artifact-'));
  const requests = [];
  const bytes = options.bytes ?? Buffer.from('Delivered exactly: 你好\n');
  let sends = 0;
  let artifactRequested;
  const requested = new Promise(resolve => { artifactRequested = resolve; });
  const task = id => ({ id, contextId: 'original-context', status: { state: options.state || 'TASK_STATE_WORKING' },
    artifacts: [{ artifactId, parts: [{ url: artifactId }],
      metadata: { contentAvailability: 'reference_only', sizeBytes: bytes.length, sha256: digest(bytes) } }] });
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/agents/receiver/.well-known/agent-card.json') {
      if (options.respondCard) { options.respondCard(req, res); return; }
      res.end(JSON.stringify({ name: 'Hermes Receiver', version: '1.0.0', capabilities: {},
        defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
        supportedInterfaces: [{ url: `${origin}/agents/receiver/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ ...body, url: req.url, headers: req.headers });
    let result;
    if (body.method === 'SendMessage') result = { task: task(++sends === 1 ? 'original-task' : 'transfer-task') };
    else if (body.method === 'GetTask') result = task(body.params.id);
    else if (body.method === 'GetArtifact') {
      artifactRequested();
      if (options.respondArtifact) { options.respondArtifact(req, res, body); return; }
      const reply = { jsonrpc: '2.0', id: body.id, result: { artifact: { artifactId,
        parts: [{ raw: bytes.toString('base64'), filename: 'deliverable.bin', mediaType: options.mediaType || 'text/plain' }],
        metadata: { contentAvailability: 'inline', sizeBytes: bytes.length, sha256: digest(bytes),
          downloadSource: 'relay_temp', expiresAt: '2099-01-01T00:00:00Z' } } } };
      options.mutateReply?.(reply);
      res.end(JSON.stringify(reply));
      return;
    } else {
      res.statusCode = 404; res.end(); return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const connectorState = join(directory, 'controller.json');
  const enrollment = { agentId: 'controller', token: 'agt_controller.first',
    card: `${origin}/agents/controller/.well-known/agent-card.json` };
  await writeFile(connectorState, JSON.stringify(enrollment), { mode: 0o600 });
  const config = { connectorState, storePath: join(directory, 'conversations.json'),
    agents: [{ id: 'hermes', card: `${origin}/agents/receiver/.well-known/agent-card.json`, allowHttp: true }] };
  const tools = [];
  const a2a = installOutbound({ subagents: { registerProvider() {} }, tools: { register(tool) { tools.push(tool); } } }, config);
  const send = tools.find(tool => tool.name === 'a2a_send');
  const artifact = tools.find(tool => tool.name === 'a2a_artifact');
  const first = JSON.parse((await send.execute({ agent_id: 'hermes', message: 'Produce the authorized file',
    message_id: 'original-message' }, execution)).text);
  assert.equal(first.taskId, 'original-task');
  const args = { conversation_id: first.conversationId, artifact_id: artifactId };
  return { a2a, config, tools, send, artifact, args, first, requests, directory, connectorState, enrollment, bytes, requested };
}

test('native artifact tool downloads a working task with rotated caller credentials and no remote mutation', async t => {
  const f = await fixture(t);
  await writeFile(f.connectorState, JSON.stringify({ ...f.enrollment, token: 'agt_controller.rotated' }));
  const saved = await readFile(f.config.storePath, 'utf8');
  const before = f.requests.length;
  const value = JSON.parse((await f.artifact.execute(f.args, execution)).text);
  assert.equal(value.conversationId, f.first.conversationId);
  assert.equal(value.taskId, 'original-task');
  assert.equal(value.artifactId, artifactId);
  assert.equal(value.encoding, 'utf-8');
  assert.equal(value.text, f.bytes.toString());
  assert.equal(value.metadata.sizeBytes, f.bytes.length);
  assert.equal(value.metadata.sha256, digest(f.bytes));
  assert.equal(value.metadata.downloadSource, 'relay_temp');
  assert.equal(value.metadata.expiresAt, '2099-01-01T00:00:00Z');
  assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
  const request = f.requests.at(-1);
  assert.equal(request.headers.authorization, 'Bearer agt_controller.rotated');
  assert.equal(request.headers['a2a-version'], '1.0');
  assert.equal(request.headers['idempotency-key'], undefined);
  assert.equal(request.url, '/agents/receiver/rpc');
  assert.deepEqual(request.params, { id: 'original-task', artifactId, maxBytes: 524288 });
  assert.equal(await readFile(f.config.storePath, 'utf8'), saved);
});

test('native artifact tool preserves binary, empty files and UTF-8 BOMs exactly', async t => {
  for (const [name, bytes, encoding] of [
    ['binary Base64', Buffer.from([0, 255, 254, 1]), 'base64'],
    ['empty file', Buffer.alloc(0), 'utf-8'],
    ['UTF-8 BOM', Buffer.from('\ufeffexact BOM\n'), 'utf-8'],
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { bytes, mediaType: 'application/octet-stream' });
      const value = JSON.parse((await f.artifact.execute(f.args, execution)).text);
      assert.equal(value.metadata.sizeBytes, bytes.length);
      assert.equal(value.metadata.sha256, digest(bytes));
      assert.deepEqual(value.encoding === 'base64' ? Buffer.from(value.raw, 'base64') : Buffer.from(value.text), bytes);
      assert.equal(value.encoding, encoding);
    });
  }
});

test('native artifact tool saves an 8 MiB file privately without returning or overwriting its contents', async t => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0xab);
  const f = await fixture(t, { bytes, mediaType: 'application/octet-stream' });
  const outputPath = join(f.directory, 'download.bin');
  const value = JSON.parse((await f.artifact.execute({ ...f.args, output_path: outputPath }, execution)).text);
  assert.equal(value.path, outputPath);
  assert.equal(value.metadata.sizeBytes, bytes.length);
  assert.equal(value.metadata.sha256, digest(bytes));
  assert.equal(value.raw, undefined);
  assert.equal(value.text, undefined);
  assert.deepEqual(await readFile(outputPath), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(f.requests.at(-1).params.maxBytes, 8388608);
  await writeFile(outputPath, 'keep this existing file');
  await assert.rejects(f.artifact.execute({ ...f.args, output_path: outputPath }, execution), /EEXIST/);
  assert.equal(await readFile(outputPath, 'utf8'), 'keep this existing file');
});

test('original business task remains downloadable after a transfer follow-up and store reload', async t => {
  const f = await fixture(t, { state: 'TASK_STATE_COMPLETED' });
  const followUp = JSON.parse((await f.send.execute({ agent_id: 'hermes', conversation_id: f.first.conversationId,
    message_id: 'transfer-message', message: 'Upload only the existing file to original-task' }, execution)).text);
  assert.equal(followUp.taskId, 'transfer-task');
  const tools = [];
  installOutbound({ subagents: { registerProvider() {} }, tools: { register(tool) { tools.push(tool); } } }, f.config);
  const artifact = tools.find(tool => tool.name === 'a2a_artifact');
  const before = f.requests.length;
  const original = JSON.parse((await artifact.execute({ ...f.args, task_id: 'original-task' }, execution)).text);
  assert.equal(original.taskId, 'original-task');
  assert.equal(f.requests.at(-1).params.id, 'original-task');
  const current = JSON.parse((await artifact.execute(f.args, execution)).text);
  assert.equal(current.taskId, 'transfer-task');
  assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact', 'GetArtifact']);
});

test('native artifact tool rejects foreign sessions, unknown tasks and invalid arguments before requesting bytes', async t => {
  const f = await fixture(t);
  const before = f.requests.length;
  await assert.rejects(f.artifact.execute(f.args, { agent: { session: { id: 'another-session' } } }), /not found/);
  await assert.rejects(f.artifact.execute(f.args, {}), /active DSH agent session/);
  await assert.rejects(f.artifact.execute({ ...f.args, task_id: 'unrelated-task' }, execution), /not recorded/);
  for (const id of ['https://example.test/file', 'agent:///../secret', 'agent:///tmp/%2fsecret', 'agent:///']) {
    await assert.rejects(f.artifact.execute({ ...f.args, artifact_id: id }, execution), /registered agent/);
  }
  for (const maxBytes of [0, -1, 1.5, 524289, NaN]) {
    await assert.rejects(f.artifact.execute({ ...f.args, max_bytes: maxBytes }, execution), /max_bytes/);
  }
  await assert.rejects(f.artifact.execute({ ...f.args, output_path: 'relative.bin' }, execution), /absolute/);
  await assert.rejects(f.artifact.execute({ ...f.args, output_path: join(f.directory, 'too-large'), max_bytes: 8388609 }, execution), /max_bytes/);
  assert.equal(f.requests.length, before);
});

test('corrupt or mismatched remote file contents are rejected before creating an output file', async t => {
  const changes = [
    ['wrong artifact', artifact => { artifact.artifactId = 'agent:///other/file'; }],
    ['invalid Base64', artifact => { artifact.parts[0].raw += '!'; }],
    ['wrong size', artifact => { artifact.metadata.sizeBytes++; }],
    ['wrong hash', artifact => { artifact.metadata.sha256 = '0'.repeat(64); }],
    ['reference only', artifact => { artifact.metadata.contentAvailability = 'reference_only'; }],
    ['multiple parts', artifact => { artifact.parts.push(artifact.parts[0]); }],
    ['mixed URL and bytes', artifact => { artifact.parts[0].url = artifactId; }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async t => {
      const f = await fixture(t, { mutateReply: reply => change(reply.result.artifact) });
      const outputPath = join(f.directory, 'must-not-exist');
      await assert.rejects(f.artifact.execute({ ...f.args, output_path: outputPath }, execution), /invalid|integrity/);
      await assert.rejects(stat(outputPath), { code: 'ENOENT' });
      assert.equal(f.requests.filter(req => req.method === 'SendMessage').length, 1);
    });
  }
});

test('expired artifact errors retain safe diagnostics without exposing upstream data or retrying', async t => {
  const f = await fixture(t, { mutateReply(reply) {
    delete reply.result;
    reply.error = { code: -32002, message: 'private upstream credential', data: {
      reason: 'relay_artifact_expired_or_missing', stage: 'artifact_download', retryable: false,
      secret: 'private upstream credential', url: 'https://private.example/signed-token' } };
  } });
  const before = f.requests.length;
  await assert.rejects(f.artifact.execute(f.args, execution), error => {
    assert.match(error.message, /RPC -32002; reason=relay_artifact_expired_or_missing; stage=artifact_download; retryable=false/);
    assert.doesNotMatch(error.message, /private upstream|signed-token|private\.example/);
    return true;
  });
  assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
});

test('byte limits, RPC correlation and redirects are enforced on remote responses', async t => {
  const cases = [
    ['oversized file', { bytes: Buffer.alloc(9) }, { max_bytes: 8 }, /oversized/],
    ['mismatched RPC id', { mutateReply: reply => { reply.id = 'unrelated-request'; } }, {}, /RPC envelope/],
    ['oversized content-length', { respondArtifact(_req, res) {
      res.setHeader('content-length', '1000000000'); res.end('{}');
    } }, {}, /byte limit/],
    ['bounded chunked body', { respondArtifact(_req, res) {
      res.setHeader('transfer-encoding', 'chunked'); res.write(' '.repeat(65541)); res.end();
    } }, { max_bytes: 1 }, /byte limit/],
    ['redirect', { respondArtifact(_req, res) {
      res.statusCode = 302; res.setHeader('location', '/credential-leak'); res.end('{}');
    } }, {}, /HTTP 302/],
  ];
  for (const [name, options, args, error] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t, options);
      const before = f.requests.length;
      await assert.rejects(f.artifact.execute({ ...f.args, ...args }, execution), error);
      assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
    });
  }
});

test('authorization and cancellation failures never dispatch or cancel business work', async t => {
  await t.test('task_read denial', async t => {
    const f = await fixture(t, { respondArtifact(_req, res) {
      res.statusCode = 403; res.end(JSON.stringify({ error: 'access_denied' }));
    } });
    const before = f.requests.length;
    await assert.rejects(f.artifact.execute(f.args, execution), /task_read/);
    assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
  });
  await t.test('caller abort', async t => {
    const f = await fixture(t, { respondArtifact() {} });
    const controller = new AbortController();
    const before = f.requests.length;
    const pending = f.artifact.execute(f.args, { ...execution, signal: controller.signal });
    await f.requested;
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
  });
  await t.test('transport timeout', async t => {
    const f = await fixture(t, { respondArtifact() {} });
    f.a2a.requestTimeoutMs = 30;
    const before = f.requests.length;
    await assert.rejects(f.artifact.execute(f.args, execution), /transport or protocol/);
    assert.deepEqual(f.requests.slice(before).map(req => req.method), ['GetArtifact']);
  });
});

test('uncached artifact discovery respects cancellation and suppresses raw upstream errors', async t => {
  await t.test('cancel card lookup after reload', async t => {
    const options = {};
    const f = await fixture(t, options);
    f.a2a.clients.clear();
    let received;
    const requested = new Promise(resolve => { received = resolve; });
    options.respondCard = () => { received(); };
    const controller = new AbortController();
    const before = f.requests.length;
    const pending = f.artifact.execute(f.args, { ...execution, signal: controller.signal });
    await requested;
    controller.abort();
    await assert.rejects(pending, /cancelled|transport or protocol/);
    assert.equal(f.requests.length, before);
  });
  await t.test('do not expose a card failure body', async t => {
    const options = {};
    const f = await fixture(t, options);
    f.a2a.clients.clear();
    options.respondCard = (_req, res) => { res.statusCode = 500; res.end('private upstream credential'); };
    const before = f.requests.length;
    await assert.rejects(f.artifact.execute(f.args, execution), error => {
      assert.match(error.message, /transport or protocol/);
      assert.doesNotMatch(error.message, /private upstream credential/);
      return true;
    });
    assert.equal(f.requests.length, before);
  });
});
