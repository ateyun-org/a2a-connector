import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { downloadAgentArtifact, getAgentArtifact, validArtifactURI } from '../plugins/workbuddy/a2a-client.js';

const execute = promisify(execFile);
const uri = 'agent:///workspace/relay-doctor.mjs';
const enrollment = { agentId: 'caller', token: 'agt_caller.private' };

async function fixture(t, mutate = value => value) {
  const dir = await mkdtemp(join(tmpdir(), 'workbuddy-artifact-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contents = Buffer.from([0, 255, ...Buffer.from('export const ok = true;\n')]);
  const methods = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${enrollment.token}`);
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/agent-card.json')) {
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `http://127.0.0.1:${req.socket.localPort}/agents/receiver/rpc` }] }));
      return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    methods.push(rpc.method);
    assert.deepEqual(rpc.params, { id: 'unresolved-task', artifactId: uri });
    const artifact = { artifactId: uri, name: '../../untrusted-name.mjs',
      parts: [{ raw: contents.toString('base64'), filename: '../../untrusted-name.mjs', mediaType: 'application/javascript' }],
      metadata: { sizeBytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') } };
    const value = mutate(artifact);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...(value?.error ? { error: value.error } : { result: { artifact: value } }) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { relay: base.replace('http:', 'ws:') + '/connect', allowInsecure: true, enrollment, targetId: 'receiver' };
  return { dir, contents, methods, options, base };
}

test('artifact download saves verified exact bytes from an unresolved task without submitting work', async t => {
  const f = await fixture(t);
  const destination = join(f.dir, 'relay-doctor.mjs');
  const result = await downloadAgentArtifact(f.options, 'unresolved-task', uri, destination);
  assert.deepEqual(await readFile(destination), f.contents);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal(result.path, destination);
  assert.equal(result.sizeBytes, f.contents.length);
  assert.deepEqual(f.methods, ['GetArtifact']);
  assert.deepEqual(await readdir(f.dir), ['relay-doctor.mjs']);
  await assert.rejects(downloadAgentArtifact(f.options, 'unresolved-task', uri, destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(destination), f.contents);
});

test('artifact downloads reject corrupt or mismatched replies before creating any output', async t => {
  for (const scenario of ['checksum', 'length', 'encoding', 'identity']) {
    await t.test(scenario, async t => {
      const f = await fixture(t, artifact => {
        if (scenario === 'checksum') artifact.metadata.sha256 = '0'.repeat(64);
        if (scenario === 'length') artifact.metadata.sizeBytes++;
        if (scenario === 'encoding') artifact.parts[0].raw += '!';
        if (scenario === 'identity') artifact.artifactId = 'agent:///another-file';
        return artifact;
      });
      await assert.rejects(downloadAgentArtifact(f.options, 'unresolved-task', uri, join(f.dir, 'result')), /invalid file contents|integrity check failed/);
      assert.deepEqual(await readdir(f.dir), []);
    });
  }
});

test('artifact URI validation prevents arbitrary paths before any network request', async () => {
  for (const value of ['agent:///', 'agent:////workspace/file', 'agent:///workspace/../secret', 'agent:///workspace/%2e%2e/secret', 'agent:///workspace/a?token=x', 'https://attacker.example/file']) {
    assert.equal(validArtifactURI(value), false, value);
    await assert.rejects(getAgentArtifact({}, 'task', value), /invalid artifact URI/);
  }
});

test('artifact CLI uses the paired identity and explicit output path', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'workbuddy.json'), JSON.stringify({ ...enrollment, card: `${f.base}/agents/caller/.well-known/agent-card.json` }), { mode: 0o600 });
  const destination = join(f.dir, 'download.mjs');
  const { stdout, stderr } = await execute(process.execPath, [resolve('plugins/workbuddy/cli.js'), 'artifact', 'receiver', 'unresolved-task', uri, '--output', destination],
    { env: { ...process.env, A2A_CONNECTOR_CONFIG_DIR: f.dir, A2A_CONNECTOR_INSTANCE: 'default' } });
  assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).path, destination);
  assert.deepEqual(await readFile(destination), f.contents);
  assert.deepEqual(f.methods, ['GetArtifact']);
  assert.equal(stdout.includes(enrollment.token), false);
});

test('artifact read errors retain structured diagnostics and show only safe status summaries', async t => {
  const data = { stage: 'artifact_download', artifactRegistered: true, retryable: false,
    url: 'https://private.example/signed?private-secret', ticket: 'private-secret',
    attempts: [{ source: 'entry_url', reason: 'http_status', httpStatus: 403, url: 'https://private.example/private-secret' },
      { source: 'sandbox_path', reason: 'http_status', httpStatus: 404 }] };
  const f = await fixture(t, () => ({ error: { code: -32002, message: 'Cloud artifact unavailable', data } }));
  await assert.rejects(getAgentArtifact(f.options, 'unresolved-task', uri), error => {
    assert.equal(error.code, -32002);
    assert.deepEqual(error.data, data);
    assert.match(error.message, /stage=artifact_download; entry_url=HTTP_403; sandbox_path=HTTP_404; retryable=false/);
    assert.equal(error.message.includes('private-secret'), false);
    return true;
  });
  await writeFile(join(f.dir, 'workbuddy.json'), JSON.stringify({ ...enrollment, card: `${f.base}/agents/caller/.well-known/agent-card.json` }), { mode: 0o600 });
  await assert.rejects(execute(process.execPath, [resolve('plugins/workbuddy/cli.js'), 'artifact', 'receiver', 'unresolved-task', uri, '--output', join(f.dir, 'result')],
    { env: { ...process.env, A2A_CONNECTOR_CONFIG_DIR: f.dir, A2A_CONNECTOR_INSTANCE: 'default' } }), error => {
    assert.match(error.stderr, /entry_url=HTTP_403; sandbox_path=HTTP_404; retryable=false/);
    assert.equal(error.stderr.includes('private-secret'), false);
    return true;
  });
  assert.deepEqual(await readdir(f.dir), ['workbuddy.json']);
  assert.deepEqual(f.methods, ['GetArtifact', 'GetArtifact']);
});

test('artifact diagnostics include data-plane rejection and all three paths without leaking unknown values', async t => {
  for (const rejection of ['data_query_not_supported', 'sandbox_family_mismatch', 'private-secret']) {
    const data = { stage: 'artifact_download', artifactRegistered: true, retryable: false,
      attempts: [{ source: 'entry_url', reason: 'http_status', httpStatus: 403 },
        { source: 'sandbox_data', reason: 'untrusted_url', rejection, url: 'https://private.example/?private-secret' },
        { source: 'sandbox_path', reason: 'http_status', httpStatus: 404 }] };
    const f = await fixture(t, () => ({ error: { code: -32002, message: 'Cloud artifact unavailable', data } }));
    await assert.rejects(getAgentArtifact(f.options, 'unresolved-task', uri), error => {
      assert.match(error.message, /entry_url=HTTP_403; sandbox_data=untrusted_url/);
      assert.match(error.message, /sandbox_path=HTTP_404/);
      assert.equal(error.message.includes('private-secret'), false);
      if (rejection === 'data_query_not_supported') assert.match(error.message, /\(data_query_not_supported\)/);
      if (rejection === 'sandbox_family_mismatch') assert.match(error.message, /\(sandbox_family_mismatch\)/);
      assert.deepEqual(error.data, data);
      return true;
    });
    assert.deepEqual(f.methods, ['GetArtifact']);
  }
});
