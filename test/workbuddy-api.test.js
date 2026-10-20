import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DesktopAPI } from '../plugins/workbuddy/desktop-api.js';

const scope = 'user.localassistant.readable user.localassistant.invokable';
test('desktop API uses provider authorization, online status, message send and incremental history', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer short-lived');
    seen.push([req.method, req.url]);
    let data;
    if (req.url === '/openapi/v2/localassistant') data = { online: true };
    else if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { content: 'do the task', msg_type: 'text' });
      data = { message_id: 'msg-1' };
    } else data = { messages: [{ message_id: 'msg-2', role: 'assistant', msg_type: 'text', content: ['result'] }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const api = new DesktopAPI({ accessToken: async () => ({ accessToken: 'short-lived', scope }),
    baseURL: `http://127.0.0.1:${server.address().port}/openapi/v2/`, allowInsecure: true });
  assert.equal((await api.status()).online, true);
  assert.equal(await api.send('do the task'), 'msg-1');
  assert.equal((await api.messages({ after: 'msg-1' }))[0].message_id, 'msg-2');
  assert.deepEqual(seen, [['GET', '/openapi/v2/localassistant'], ['POST', '/openapi/v2/localassistant/message'],
    ['GET', '/openapi/v2/localassistant/message?message_id=msg-1']]);
});

test('desktop API rejects missing scopes, unsafe token origins and malformed provider data', async () => {
  for (const baseURL of ['https://attacker.example/openapi/v2/', 'https://user:pass@www.workbuddy.cn/openapi/v2/', 'https://www.workbuddy.cn/private/']) {
    assert.throws(() => new DesktopAPI({ baseURL, accessToken: async () => ({}) }), /origin/);
  }
  let fetches = 0;
  const api = new DesktopAPI({ accessToken: async () => ({ accessToken: 'token', scope: 'user.task.readable user.task.invokable' }),
    fetchImpl: async () => { fetches++; throw new Error(); } });
  await assert.rejects(api.status(), /permissions are missing/);
  assert.equal(fetches, 0);
  const malformed = new DesktopAPI({ accessToken: async () => ({ accessToken: 'token', scope }),
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { online: 'true' } })) });
  await assert.rejects(malformed.status(), /online status/);
  malformed.fetch = async () => new Response(JSON.stringify({ code: 1001, data: {} }));
  await assert.rejects(malformed.send('task'), /rejected/);
});

test('message sends never retry after uncertain transport or redirect', async () => {
  let calls = 0;
  const api = new DesktopAPI({ accessToken: async () => ({ accessToken: 'token', scope }), fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    throw new Error('connection reset after provider acceptance');
  } });
  await assert.rejects(api.send('task'), /do not automatically repeat/);
  assert.equal(calls, 1);
});
