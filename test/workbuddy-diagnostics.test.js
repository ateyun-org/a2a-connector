import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { getAgentDiagnostics } from '../plugins/workbuddy/a2a-client.js';

const execute = promisify(execFile);
const enrollment = { agentId: 'caller', token: 'agt_caller.private-token' };

test('diagnostics CLI reads an owned released task without submitting work or requiring target-side CLI', async t => {
  let calls = 0;
  const expected = { taskId: 'released-task', contextId: 'original-context', state: 'TASK_STATE_REJECTED', dispatchState: 'unknown',
    diagnostics: { version: 'diagnostics-v1', executionCapture: 'not_recorded', recoveryCapture: 'not_recorded',
      upstream: { link: { present: true, valid: true, host: 'acp.workbuddy.cn', path: '/sessions/<session-id>' }, sandboxDataLinkUsed: false } },
    upstreamRefresh: { attempted: true, succeeded: true, reason: 'refreshed' } };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${enrollment.token}`);
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/agent-card.json')) {
      res.end(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: `http://127.0.0.1:${req.socket.localPort}/agents/receiver/rpc` }] }));
      return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    assert.equal(request.method, 'GetTaskDiagnostics');
    assert.deepEqual(request.params, { id: 'released-task' });
    assert.equal(req.headers['idempotency-key'], undefined);
    calls++;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: expected }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { relay: base.replace('http:', 'ws:') + '/connect', enrollment, allowInsecure: true, targetId: 'receiver' };
  assert.deepEqual(await getAgentDiagnostics(options, 'released-task'), expected);
  const dir = await mkdtemp(join(tmpdir(), 'workbuddy-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'workbuddy.json'), JSON.stringify({ ...enrollment, card: `${base}/agents/caller/.well-known/agent-card.json` }), { mode: 0o600 });
  const { stdout, stderr } = await execute(process.execPath, [resolve('plugins/workbuddy/cli.js'), 'diagnostics', 'receiver', 'released-task'],
    { env: { ...process.env, A2A_CONNECTOR_CONFIG_DIR: dir, A2A_CONNECTOR_INSTANCE: 'default' } });
  assert.deepEqual(JSON.parse(stdout), expected);
  assert.equal(stderr, '');
  assert.equal(stdout.includes(enrollment.token), false);
  assert.equal(calls, 2);
});

test('diagnostics rejects invalid task IDs before opening any connection', async () => {
  await assert.rejects(getAgentDiagnostics({}, 'bad\nID'), /invalid task ID/);
  await assert.rejects(getAgentDiagnostics({}, 'x'.repeat(256)), /invalid task ID/);
});
