// The same explicit Typert descriptors are mounted by Host and browser.
// This plugin is plain JavaScript, so its small boundary codecs are explicit.
function codec(parse, typeSymbol, jsonSchema) {
  return { mode: 'strict', typeSymbol, jsonSchema, create: () => ({ parse }) };
}

function input(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.agentId)) throw new Error('请选择有效的远程 Agent。');
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId))) {
    throw new Error('请选择有效的 DSH 会话。');
  }
  if (value.newSession !== undefined && typeof value.newSession !== 'boolean') throw new Error('新建聊天参数无效。');
  return value;
}

const json = codec(value => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Invalid control response');
  return JSON.parse(serialized);
}, 'a2aControl.Json', {});

const selection = codec(input, 'a2aControl.Selection', { type: 'object', properties: { agentId: { type: 'string' }, sessionId: { type: 'string' }, newSession: { type: 'boolean' } }, required: ['agentId'] });
export const controlContract = {
  package: 'dsh-a2a-connector',
  descriptors: Object.entries({ targets: null, open: selection }).map(([method, boundary]) => ({
    id: `dsh-a2a-connector:a2aControl/${method}`, service: 'a2aControl', namespace: 'a2aControl', method,
    invocation: { kind: 'direct' }, parameters: boundary ? [{ name: 'input', wire: 'input', source: 'json', codec: boundary }] : [], result: json,
  })),
};
