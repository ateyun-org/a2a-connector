import test from 'node:test';
import assert from 'node:assert/strict';
import { platformAccessToken, platformAuthorizationURL, platformRelayURL, platformRequest } from '../plugins/workbuddy/platform-client.js';

test('WorkBuddy platform login uses the paired Relay and validates the returned authorize URL', async () => {
  const enrollment = { token: 'agt_workbuddy.private' };
  let called = 0;
  const fetchImpl = async (url, options) => {
    called++;
    assert.equal(url.toString(), 'https://relay.example/oauth/workbuddy/start');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${enrollment.token}`);
    return { ok: true, json: async () => ({ authorizationURL: 'https://www.workbuddy.cn/openapi/v2/authorize?state=abc' }) };
  };
  const url = await platformAuthorizationURL({ relay: 'wss://relay.example/connect', enrollment, fetchImpl });
  assert.equal(url, 'https://www.workbuddy.cn/openapi/v2/authorize?state=abc');
  assert.equal(called, 1);
  await assert.rejects(platformAuthorizationURL({ relay: 'wss://relay.example/connect', enrollment,
    fetchImpl: async () => ({ ok: true, json: async () => ({ authorizationURL: 'https://evil.example/authorize' }) }) }), /unexpected authorization URL/);
});

test('WorkBuddy platform access token stays in the API return value', async () => {
  const value = await platformAccessToken({ relay: 'wss://relay.example/connect', enrollment: { token: 'paired' },
    fetchImpl: async (url) => {
      assert.equal(url.pathname, '/oauth/workbuddy/access-token');
      return { ok: true, json: async () => ({ accessToken: 'short-lived', expiresAt: 9999999999 }) };
    } });
  assert.equal(value.accessToken, 'short-lived');
  await assert.rejects(platformRequest({ relay: 'wss://relay.example/connect', enrollment: null, endpoint: 'status' }), /pair the Connector/);
  assert.throws(() => platformRelayURL('ws://relay.example/connect', 'status'), /secure Relay URL/);
});
