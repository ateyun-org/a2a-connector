import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { HybridBridge } from '../plugins/workbuddy/hybrid-bridge.js';
import { CloudBridge } from '../plugins/workbuddy/cloud-bridge.js';
import { DesktopBridge } from '../plugins/workbuddy/desktop-bridge.js';
import { DesktopAPI } from '../plugins/workbuddy/desktop-api.js';
import { TaskStore } from '../plugins/workbuddy/task-store.js';
import { createWorkBuddyAdapter } from '../plugins/workbuddy/adapter-server.js';
import { startReceiver } from '../plugins/workbuddy/receiver-runtime.js';
import { hostedConfig, startHosted } from '../plugins/workbuddy/hosted.js';
import { saveEnrollment } from '../src/connector.js';
import { cloudProvider } from './helpers/workbuddy-cloud.js';

const message = (id, mode, contextId) => ({ role: 'ROLE_USER', messageId: id, parts: [{ text: 'Produce the report' }],
  ...(mode ? { metadata: { workbuddyMode: mode } } : {}), ...(contextId ? { contextId } : {}) });
async function completed(bridge, id) {
  for (let i = 0; i < 200; i++) {
    const task = await bridge.get(id);
    if (task.state === 'TASK_STATE_COMPLETED') return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Hosted task did not finish');
}

function desktopAPI(accessToken = async () => ({ accessToken: 'desktop-secret', scope: 'user.localassistant.readable user.localassistant.invokable' }), results = []) {
  const messages = [];
  return new DesktopAPI({ accessToken, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://www.workbuddy.cn');
    if (url.pathname.endsWith('/localassistant')) return Response.json({ code: 0, data: { online: true } });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body), id = /^\[A2A_TASK:([^\]]+)\]/.exec(body.content)[1];
      results.push({ authorization: options.headers.Authorization, text: body.content });
      messages.push({ message_id: 'answer-' + id, role: 'assistant', msg_type: 'text', content: [
        JSON.stringify({ a2aTaskId: id, status: 'completed', text: 'Desktop provider result' })] });
      return Response.json({ code: 0, data: { message_id: 'user-' + id } });
    }
    return Response.json({ code: 0, data: { messages } });
  } });
}

test('one hosted identity routes cloud/desktop through remote APIs, preserves mode across contexts, and rejects changed-mode retries', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbuddy-hybrid-'));
  const provider = await cloudProvider(t);
  const desktopResults = [];
  const make = () => new HybridBridge({
    cloud: new CloudBridge({ ...provider, store: new TaskStore(join(dir, 'cloud.json')) }),
    desktop: new DesktopBridge({ api: desktopAPI(undefined, desktopResults), store: new TaskStore(join(dir, 'desktop.json')), pollIntervalMs: 5 }),
  });
  let bridge = make(); await bridge.start();
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const token = 'x'.repeat(32), adapter = createWorkBuddyAdapter({ bridge, token });
  await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
  const card = await (await fetch(`http://127.0.0.1:${adapter.server.address().port}/.well-known/agent-card.json`, {
    headers: { authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(card.skills.map(skill => skill.id), ['workbuddy-cloud', 'workbuddy-desktop']);
  assert.equal(card.metadata.defaultExecutionMode, 'cloud');
  const send = async input => {
    const response = await fetch(`http://127.0.0.1:${adapter.server.address().port}/rpc`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: input } }) });
    const body = await response.json(); assert.equal(body.error, undefined); return body.result.task;
  };
  const cloud = await send(message('cloud-first'));
  assert.equal((await completed(bridge, cloud.id)).output, '云端实际结果');
  const desktop = await send(message('desktop-first', 'desktop'));
  assert.equal((await completed(bridge, desktop.id)).output, 'Desktop provider result');
  assert.equal((await bridge.get(desktop.id)).mode, 'desktop');
  await assert.rejects(bridge.submit(message('desktop-first', 'cloud')), /cannot change execution mode/);
  await assert.rejects(bridge.submit(message('changed-context', 'cloud', desktop.contextId)), /cannot change execution mode/);
  await assert.rejects(bridge.submit(message('invalid', 'elsewhere')), /must be cloud or desktop/);
  const legacyDesktop = await bridge.desktop.get(desktop.id);
  await bridge.cloud.store.transact(tasks => tasks.push(legacyDesktop));
  await bridge.desktop.store.transact(tasks => { tasks.splice(0); });
  await adapter.close();
  bridge = make(); await bridge.start();
  const duplicate = await bridge.submit(message('desktop-first'));
  assert.equal(duplicate.id, desktop.id); assert.equal(desktopResults.length, 1);
  const followup = await bridge.submit(message('desktop-followup', undefined, desktop.contextId));
  assert.equal((await completed(bridge, followup.id)).mode, 'desktop');
  assert.equal(provider.prompts.length, 1); assert.equal(desktopResults.length, 2);
  const race = await Promise.allSettled([bridge.submit(message('mode-race', 'cloud')), bridge.submit(message('mode-race', 'desktop'))]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter(result => result.status === 'rejected').length, 1);
  await completed(bridge, race.find(result => result.status === 'fulfilled').value.id);
  assert.doesNotMatch(await readFile(join(dir, 'desktop.json'), 'utf8'), /desktop-secret|oauth-secret/);
});

test('shared hosted service isolates two receivers, uses their own OAuth credentials, and releases all managed state locks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workbuddy-hosted-'));
  const sockets = new Map(), results = [];
  const relay = createServer((req, res) => {
    assert.equal(req.url, '/oauth/workbuddy/access-token');
    const owner = req.headers.authorization?.slice('Bearer connector-'.length);
    assert.ok(['user-a', 'user-b'].includes(owner));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accessToken: 'upstream-' + owner, expiresAt: Date.now() + 60000,
      scope: 'user.localassistant.readable user.localassistant.invokable' }));
  });
  const wss = new WebSocketServer({ noServer: true });
  relay.on('upgrade', (req, socket, head) => {
    const id = req.headers.authorization?.slice('Bearer connector-'.length);
    wss.handleUpgrade(req, socket, head, ws => { sockets.set(id, ws); ws.on('close', () => sockets.delete(id)); });
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const config = hostedConfig({ relay: `ws://127.0.0.1:${relay.address().port}/connect`, allowInsecure: true, stateDir: dir,
    receivers: ['user-a', 'user-b'].map(agentId => ({ agentId, name: agentId, adapter: 'desktop' })) });
  for (const receiver of config.receivers) await saveEnrollment(receiver.state, { agentId: receiver.agentId, token: 'connector-' + receiver.agentId });
  const host = await startHosted(config, { runtimeFactory: (receiver, state) => startReceiver(receiver, state, {
    apiFactory: (mode, accessToken) => desktopAPI(accessToken, results) }) });
  t.after(async () => {
    await host.close();
    for (const ws of sockets.values()) ws.terminate();
    await new Promise(resolve => wss.close(resolve)); relay.closeAllConnections();
    await new Promise(resolve => relay.close(resolve)); await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && sockets.size < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.size, 2, 'both hosted identities connect without a user-machine service');
  const a = await host.runtimes[0].bridge.submit(message('same-business-id'));
  const b = await host.runtimes[1].bridge.submit(message('same-business-id'));
  await Promise.all(host.runtimes.map((runtime, index) => completed(runtime.bridge, [a, b][index].id)));
  assert.deepEqual(results.map(value => value.authorization).sort(), ['Bearer upstream-user-a', 'Bearer upstream-user-b']);
  await assert.rejects(host.runtimes[0].bridge.get(b.id), /not found/i);
  await assert.rejects(startReceiver(config.receivers[0], config.receivers[0].state), /state_locked/);
  await host.close();
  for (const receiver of config.receivers) await assert.rejects(readFile(receiver.state + '.runner.lock/owner.json'), { code: 'ENOENT' });
});

test('hosted configuration rejects shared identities/state paths and startup rolls back partially started receivers', async () => {
  assert.throws(() => hostedConfig({ receivers: [{ agentId: '../bad', name: 'bad' }] }), /valid and unique/);
  assert.throws(() => hostedConfig({ receivers: [{ agentId: 'a', name: 'a' }, { agentId: 'a', name: 'b' }] }), /valid and unique/);
  assert.throws(() => hostedConfig({ receivers: [{ agentId: 'a', name: 'a', stateFile: '/tmp/shared' },
    { agentId: 'b', name: 'b', stateFile: '/tmp/shared' }] }), /separate state files/);
  const dir = await mkdtemp(join(tmpdir(), 'hosted-startup-'));
  let closed = 0;
  try {
    await assert.rejects(startHosted(hostedConfig({ stateDir: dir, receivers: [{ agentId: 'a', name: 'a' }, { agentId: 'b', name: 'b' }] }), {
      runtimeFactory: async receiver => { if (receiver.agentId === 'b') throw new Error('start failed'); return { close: async () => { closed++; } }; },
    }), /start failed/);
    assert.equal(closed, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
