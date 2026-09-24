import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { Connector, loadEnrollment, register, saveEnrollment } from '../src/connector.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('registers once and stores a private credential', async t => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    assert.equal(request.url, '/register');
    response.writeHead(calls === 1 ? 201 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(calls === 1 ? { agentId: 'coder', token: 'agt_coder.secret', card: 'https://relay/card' } : { error: 'invalid' }));
  });
  const base = await listen(server);
  t.after(() => server.close());
  const relay = `ws://${new URL(base).host}/connect`;
  const code = 'pair_' + 'a'.repeat(48);
  const value = await register({ relay, code, allowInsecure: true });
  assert.equal(value.agentId, 'coder');
  const path = join(await mkdtemp(join(tmpdir(), 'a2a-connector-')), 'state.json');
  await saveEnrollment(path, value);
  assert.deepEqual(await loadEnrollment(path), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(register({ relay, code, allowInsecure: true }), /status 401/);
});

test('discovers a local Agent and forwards HTTP frames without leaking caller auth', async t => {
  const local = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer local-secret');
    if (request.url === '/.well-known/agent-card.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'Local Agent' }));
    } else {
      let body = '';
      for await (const part of request) body += part;
      assert.equal(request.url, '/a2a?test=1');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    }
  });
  const localURL = await listen(local);
  t.after(() => local.close());
  const relay = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  relay.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.authorization, 'Bearer agent-secret');
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws);
    });
  });
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'request.start', requestId: 'one', method: 'POST', path: '/a2a?test=1',
      headers: { Authorization: ['Bearer dsh-secret'], 'Content-Type': ['application/json'] } }));
    ws.send(JSON.stringify({ type: 'request.body', requestId: 'one', body: Buffer.from('{"method":"SendMessage"}').toString('base64') }));
    ws.send(JSON.stringify({ type: 'request.end', requestId: 'one' }));
    const frames = [];
    ws.on('message', raw => {
      frames.push(JSON.parse(raw.toString()));
      if (frames.at(-1).type === 'response.end') {
        completed(frames);
        ws.close();
      }
    });
  });
  const relayURL = await listen(relay);
  t.after(async () => { wss.close(); relay.close(); });
  const client = new Connector({ relay: `ws://${new URL(relayURL).host}/connect`, local: localURL,
    token: 'agent-secret', localToken: 'local-secret', allowInsecure: true });
  assert.equal((await client.discover()).name, 'Local Agent');
  let timer;
  try {
    await Promise.race([client.connectOnce(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); })]);
  } finally { clearTimeout(timer); }
  const frames = await done;
  assert.equal(frames[0].status, 200);
  assert.equal(Buffer.concat(frames.filter(x => x.type === 'response.body').map(x => Buffer.from(x.body, 'base64'))).toString(),
    '{"method":"SendMessage"}');
});
