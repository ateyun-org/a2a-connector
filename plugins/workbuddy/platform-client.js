export function platformRelayURL(relay, endpoint, allowInsecure = false) {
  const url = new URL(relay);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:' && allowInsecure) url.protocol = 'http:';
  else throw new Error('WorkBuddy platform OAuth requires a secure Relay URL');
  url.pathname = `/oauth/workbuddy/${endpoint}`;
  url.search = '';
  url.hash = '';
  return url;
}

export async function platformRequest({ relay, allowInsecure, enrollment, endpoint, method = 'GET', fetchImpl = fetch }) {
  if (!enrollment?.token) throw new Error('pair the Connector before linking WorkBuddy');
  const response = await fetchImpl(platformRelayURL(relay, endpoint, allowInsecure), {
    method, redirect: 'manual',
    headers: { Authorization: `Bearer ${enrollment.token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`WorkBuddy platform request failed (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(`WorkBuddy platform request failed (HTTP ${response.status}: ${result.error || 'unknown'})`);
  return result;
}

export async function platformAuthorizationURL(options) {
  const result = await platformRequest({ ...options, endpoint: 'start', method: 'POST' });
  const url = new URL(result.authorizationURL);
  if (url.protocol !== 'https:' || url.hostname !== 'www.workbuddy.cn' ||
      url.pathname !== '/openapi/v2/authorize') throw new Error('Relay returned an unexpected authorization URL');
  return url.toString();
}

export async function platformAccessToken(options) {
  const result = await platformRequest({ ...options, endpoint: 'access-token' });
  if (!result.accessToken || !Number.isSafeInteger(result.expiresAt)) {
    throw new Error('Relay returned an incomplete WorkBuddy access token');
  }
  return result;
}
