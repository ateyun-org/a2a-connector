export const desktopControlInstructions = '请在执行任务的电脑上打开 WorkBuddy：左下角「连接移动端」→「小程序」→ 开启「允许移动端连接此设备」。保持电脑端登录并在线；此开关需要你自行确认，程序不会自动修改。';

export function platformRelayURL(relay, endpoint, allowInsecure = false) {
  const url = new URL(relay);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/connect' ||
      !['start', 'status', 'access-token', 'session', 'setup'].includes(endpoint)) throw new Error('Invalid WorkBuddy Relay endpoint');
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
  if (!response.ok) {
    const error = new Error(`WorkBuddy platform request failed (HTTP ${response.status}: ${result.error || 'unknown'})`);
    if (result.error === 'workbuddy_not_authorized') {
      error.message += `。受控端尚未完成 WorkBuddy 账号授权，请在该接收端运行 platform login，或返回连接器点击连接。接入说明：${platformRelayURL(relay, 'setup', allowInsecure)}`;
    }
    throw error;
  }
  return result;
}

export async function platformAuthorizationURL(options) {
  const result = await platformRequest({ ...options, endpoint: 'start', method: 'POST' });
  const url = new URL(result.authorizationURL);
  if (url.origin !== 'https://www.workbuddy.cn' || url.username || url.password || url.hash ||
      url.pathname !== '/openapi/v2/authorize') throw new Error('Relay returned an unexpected authorization URL');
  return url.toString();
}

export async function platformSetupURL(options, mode = 'desktop') {
  if (!['desktop', 'cloud'].includes(mode)) throw new Error('Invalid WorkBuddy setup mode');
  const authorization = new URL(await platformAuthorizationURL(options));
  const state = authorization.searchParams.get('state');
  if (!/^[0-9a-f]{64}$/.test(state || '') || authorization.searchParams.getAll('state').length !== 1) {
    throw new Error('Relay returned an invalid WorkBuddy authorization state');
  }
  const guide = platformRelayURL(options.relay, 'setup', options.allowInsecure);
  guide.searchParams.set('state', state);
  guide.searchParams.set('mode', mode);
  return guide.toString();
}

export async function platformAccessToken(options) {
  const result = await platformRequest({ ...options, endpoint: 'access-token' });
  if (!result.accessToken || !Number.isSafeInteger(result.expiresAt)) {
    throw new Error('Relay returned an incomplete WorkBuddy access token');
  }
  return result;
}
