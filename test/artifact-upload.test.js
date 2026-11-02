import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveEnrollment, uploadArtifact } from '../src/connector.js';
import { acquireStateLock } from '../src/state-lock.js';

const run = promisify(execFile);

async function fixture(t, mutate = value => value) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-file-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '中文 文件.bin');
  const bytes = Buffer.from([0, 255, 42, 128, 10]);
  await writeFile(file, bytes);
  const enrollment = { agentId: 'receiver', token: 'agt_receiver.private-connector-secret' };
  const received = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/relay/artifacts/publish');
    assert.equal(request.headers.authorization, `Bearer ${enrollment.token}`);
    assert.equal(request.headers['x-artifact-task'], 'original-task');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.deepEqual(body, bytes);
    const sha256 = createHash('sha256').update(body).digest('hex');
    assert.equal(request.headers['x-artifact-sha256'], sha256);
    const uri = decodeURI(request.headers['x-artifact-uri']);
    received.push(uri);
    const value = mutate({ taskId: 'original-task', artifact: { artifactId: uri, name: 'file', parts: [{ url: uri }],
      metadata: { downloadSource: 'relay_temp', sizeBytes: body.length, sha256, expiresAt: new Date(Date.now() + 3600000).toISOString() } } });
    response.writeHead(value.httpStatus ?? 200, { 'content-type': 'application/json', ...(value.headers ?? {}) });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const relay = `ws://127.0.0.1:${server.address().port}/connect`;
  return { directory, file, enrollment, bytes, received, options: { relay, enrollment, file, taskId: 'original-task', allowInsecure: true } };
}

test('receiving Connector publishes only an explicitly selected file and verifies registration', async t => {
  const f = await fixture(t);
  const result = await uploadArtifact(f.options);
  assert.equal(result.taskId, 'original-task');
  assert.equal(result.artifact.metadata.sizeBytes, f.bytes.length);
  assert.equal(f.received.length, 1);
  assert.equal(result.artifact.artifactId, `agent://${await realpath(f.file)}`);
  assert.equal(JSON.stringify(result).includes(f.enrollment.token), false);
});

test('receiving CLI uploads with its current state while the Connector runtime lock is held', async t => {
  const f = await fixture(t);
  const state = join(f.directory, 'receiver.json');
  await saveEnrollment(state, f.enrollment);
  const lock = await acquireStateLock(state);
  t.after(() => lock.release());
  const { stdout, stderr } = await run(process.execPath, ['src/cli.js', '--relay', f.options.relay, '--state', state,
    '--artifact-upload', f.file, '--task-id', 'original-task', '--allow-insecure']);
  assert.equal(JSON.parse(stdout).artifact.metadata.downloadSource, 'relay_temp');
  assert.equal((stdout + stderr).includes(f.enrollment.token), false);
  assert.equal(f.received.length, 1);
});

test('file upload rejects missing, non-file, oversized and noncanonical inputs before networking', async t => {
  const f = await fixture(t);
  const large = join(f.directory, 'large.bin');
  await writeFile(large, '');
  await truncate(large, 8 * 1024 * 1024 + 1);
  for (const changes of [{ file: join(f.directory, 'missing') }, { file: f.directory }, { file: large },
    { taskId: '' }, { artifactId: 'agent:///workspace/../secret' }]) {
    await assert.rejects(uploadArtifact({ ...f.options, ...changes }));
  }
  assert.equal(f.received.length, 0);
});

test('upload rejects corrupt registrations without repeating the request', async t => {
  for (const field of ['task', 'uri', 'hash', 'length']) {
    await t.test(field, async t => {
      const f = await fixture(t, value => {
        if (field === 'task') value.taskId = 'another-task';
        if (field === 'uri') value.artifact.artifactId = 'agent:///other-file';
        if (field === 'hash') value.artifact.metadata.sha256 = '0'.repeat(64);
        if (field === 'length') value.artifact.metadata.sizeBytes++;
        return value;
      });
      await assert.rejects(uploadArtifact(f.options), /invalid registration/);
      assert.equal(f.received.length, 1);
    });
  }
});

test('upload refuses redirects and does not expose the private response body', async t => {
  const f = await fixture(t, () => ({ httpStatus: 302, headers: { location: 'http://127.0.0.1:1/credential-leak' }, secret: 'private-response' }));
  await assert.rejects(uploadArtifact(f.options), error => {
    assert.match(error.message, /HTTP 302/);
    assert.equal(error.message.includes('private-response'), false);
    assert.equal(error.message.includes(f.enrollment.token), false);
    return true;
  });
  assert.equal(f.received.length, 1);
});
