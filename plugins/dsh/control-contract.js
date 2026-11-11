// The same explicit Typert descriptors are mounted by Host and browser.
// This plugin is plain JavaScript, so its small boundary codecs are explicit.
function codec(parse, typeSymbol, jsonSchema) {
  return { mode: 'strict', typeSymbol, jsonSchema, create: () => ({ parse }) };
}

function input(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.agentId)) throw new Error('请选择有效的远程 Agent。');
  return value;
}

const json = codec(value => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Invalid control response');
  return JSON.parse(serialized);
}, 'a2aControl.Json', {});

const selection = codec(input, 'a2aControl.Selection', { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] });
const send = codec(value => {
  input(value);
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 32000 ||
      typeof value.messageId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.messageId)) throw new Error('消息须为 1 至 32000 个字符，并携带固定消息编号。');
  return { agentId: value.agentId, text: value.text, messageId: value.messageId };
}, 'a2aControl.Send', { type: 'object', properties: { agentId: { type: 'string' }, text: { type: 'string' }, messageId: { type: 'string' } }, required: ['agentId', 'text', 'messageId'] });

export const controlContract = {
  package: 'dsh-a2a-connector',
  descriptors: Object.entries({ targets: null, chat: selection, send, poll: selection }).map(([method, boundary]) => ({
    id: `dsh-a2a-connector:a2aControl/${method}`, service: 'a2aControl', namespace: 'a2aControl', method,
    invocation: { kind: 'direct' }, parameters: boundary ? [{ name: 'input', wire: 'input', source: 'json', codec: boundary }] : [], result: json,
  })),
};
