import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { loadEnrollment, saveEnrollment, requestPairing, pairingStatus } from '../src/connector.js';

const run = promisify(execFile);
const ticket = 'pair_' + 'a'.repeat(48);
const identity = { agentId: 'enterprise-agent', token: 'agt_enterprise-agent.private-test-secret' };
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { host = 'openclaw', status = 201, returnedID = identity.agentId, lostResponse = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-enterprise-install-'));
  const requests = [], auth = [];
  const local = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'Enterprise Agent' }));
  });
  const localURL = await listen(local);
  const relay = createServer(async (request, response) => {
    requests.push(request.url);
    if (request.url === '/register') {
      let body = '';
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { code: ticket });
      if (lostResponse) { request.socket.destroy(); return; }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 201 ? { ...identity, agentId: returnedID } : { error: 'invalid_pairing_code' }));
    } else {
      response.writeHead(410, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'organization_ticket_required' }));
    }
  });
  const relayURL = await listen(relay);
  const wss = new WebSocketServer({ noServer: true });
  relay.on('upgrade', (request, socket, head) => {
    auth.push(request.headers.authorization);
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  const state = join(directory, host === 'workbuddy' ? 'workbuddy.json' : 'state.json');
  const stateArgs = host === 'workbuddy' ? [] : ['--state', state];
  const baseArgs = ['scripts/install-connector.sh'];
  const args = ['install', '--host', host, '--enterprise', '--expect-agent-id', identity.agentId,
    '--relay', `ws://${new URL(relayURL).host}/connect`, '--local', localURL,
    '--allow-insecure', ...stateArgs];
  const cleanEnv = { ...process.env, A2A_CONNECTOR_CONFIG_DIR: directory };
  delete cleanEnv.A2A_PAIR_CODE;
  const withTicket = { ...cleanEnv, A2A_PAIR_CODE: ticket };
  const command = (commandArgs, env = cleanEnv) => run('sh', [...baseArgs, ...commandArgs], { timeout: 12000, env });
  const stop = () => command(['stop', '--host', host, ...stateArgs]);
  t.after(async () => {
    await stop().catch(() => {});
    for (const client of wss.clients) client.terminate();
    wss.close();
    await Promise.all([new Promise(resolve => local.close(resolve)), new Promise(resolve => relay.close(resolve))]);
  });
  return { directory, state, args, requests, auth, withTicket, cleanEnv, command, stop,
    relay: `ws://${new URL(relayURL).host}/connect` };
}

for (const host of ['openclaw', 'hermes', 'dsh', 'workbuddy']) {
  test(`enterprise installer redeems once and reuses credentials across ${host} restarts`, async t => {
    const f = await fixture(t, { host });
    await saveEnrollment(f.state + '.pending', { agentId: 'legacy-pending-agent', requestId: 'c'.repeat(64), confirmationCode: 'ABC123' });
    const installed = await f.command(f.args, f.withTicket);
    assert.match(installed.stdout, /企业接入身份已确认/, installed.stderr);
    assert(!installed.stdout.includes(ticket) && !installed.stderr.includes(ticket));
    assert(!installed.stdout.includes(identity.token) && !installed.stderr.includes(identity.token));
    assert.deepEqual(await loadEnrollment(f.state), identity);
    await assert.rejects(readFile(f.state + '.pending'), { code: 'ENOENT' });
    assert.equal((await stat(f.state)).mode & 0o777, 0o600);
    assert.deepEqual(f.requests, ['/register'], 'enterprise installation used legacy pairing or redeemed twice');
    assert.deepEqual(f.auth, [`Bearer ${identity.token}`], 'tunnel did not use the saved credential');
    const repeated = await f.command(f.args, f.withTicket);
    assert.match(repeated.stdout, /复用现有身份/);
    assert.deepEqual(f.requests, ['/register']);
    await f.stop();
    await f.command(f.args); // Restart without retaining the one-time ticket.
    assert.deepEqual(f.requests, ['/register']);
    assert.equal(f.auth.length, 2);
    for (const name of await readdir(f.directory)) {
      if ((await stat(join(f.directory, name))).isFile()) {
        assert(!(await readFile(join(f.directory, name), 'utf8')).includes(ticket), `ticket was persisted in ${name}`);
      }
    }
  });
}

test('enterprise installation fails before networking when a ticket or expected identity is missing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.command(f.args), /私有环境变量 A2A_PAIR_CODE/);
  const noIdentity = f.args.filter((value, index, values) => value !== '--expect-agent-id' && values[index - 1] !== '--expect-agent-id');
  await assert.rejects(f.command(noIdentity, f.withTicket), /需要 --expect-agent-id/);
  await assert.rejects(f.command([...f.args, '--request-only'], f.withTicket), /不使用 --request-only/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.auth, []);
});

test('enterprise installation preserves another identity without consuming a ticket', async t => {
  const f = await fixture(t);
  const previous = { agentId: 'other-enterprise-agent', token: 'agt_other.saved-secret' };
  await saveEnrollment(f.state, previous);
  await assert.rejects(f.command(f.args, f.withTicket), /已有凭据属于其他 Agent/);
  assert.deepEqual(await loadEnrollment(f.state), previous);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.auth, []);
});

for (const lostResponse of [false, true]) {
  test(`enterprise installation stops without retry after ${lostResponse ? 'a lost redemption response' : 'a rejected ticket'}`, async t => {
    const f = await fixture(t, { status: 401, lostResponse });
    await assert.rejects(f.command(f.args, f.withTicket), error => {
      assert.match(error.stderr, /不要自动重试兑换/);
      assert(!error.stdout.includes(ticket) && !error.stderr.includes(ticket));
      return true;
    });
    assert.deepEqual(f.requests, ['/register']);
    assert.deepEqual(f.auth, []);
    await assert.rejects(readFile(f.state), { code: 'ENOENT' });
  });
}

test('enterprise installation saves but does not connect a mismatched redemption identity', async t => {
  const f = await fixture(t, { returnedID: 'unexpected-agent' });
  await assert.rejects(f.command(f.args, f.withTicket), /返回的机器身份.*不符/);
  assert.equal((await loadEnrollment(f.state)).agentId, 'unexpected-agent');
  assert.deepEqual(f.requests, ['/register']);
  assert.deepEqual(f.auth, []);
});

test('legacy requests to an enterprise Relay explain the ticket requirement', async t => {
  const f = await fixture(t);
  await assert.rejects(requestPairing({ relay: f.relay, agentId: 'legacy-agent', name: 'Legacy', allowInsecure: true }), /organization_ticket_required.*console-issued ticket/);
  await assert.rejects(pairingStatus({ relay: f.relay, requestId: 'b'.repeat(64), allowInsecure: true }), /organization_ticket_required.*instead of polling/);
});
