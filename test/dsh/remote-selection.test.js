import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteSelection } from '../../plugins/dsh/client/remote-selection.js';

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { if (next === value) return; value = next; for (const listener of listeners) listener(); } };
}
function host() {
  const rows = {}, bindings = new Map(), calls = [], navigations = [], blocks = new Map(), storage = new Map();
  let active, navigation, opened = 0, delay;
  const list = store({ byId: {} });
  function publish() { list.set({ byId: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, { ...row, retainedBy: id === active ? { mainView: 1 } : {} }])) }); }
  function show(id, { blank = true, cwd = '/workspace/a' } = {}) {
    if (!rows[id]) rows[id] = { id, blank, cwd };
    active = id; ctx.layout.beginNavigation(); publish();
  }
  const block = id => { if (!blocks.has(id)) blocks.set(id, store(undefined)); return blocks.get(id); };
  const ctx = {
    sessions: { list, async refresh() { publish(); }, async create({ cwd } = {}) { const id = `local-${++opened}`; rows[id] = { id, cwd, blank: true }; publish(); return id; } },
    layout: { beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; } },
    uiWorkspace: { openSession(id) { navigations.push(id); show(id); } },
    conversation: { blocks: { storeFor: block, set(id, value) { block(id).set(value); } } },
  };
  const remote = { async open(input) {
    calls.push(input);
    const wait = delay?.(input);
    if (wait) await wait;
    let sessionId = input.sessionId;
    if (input.newSession) {
      sessionId = `new-${++opened}`;
      rows[sessionId] = { id: sessionId, blank: true, cwd: rows[input.sessionId]?.cwd || '/workspace/a' };
    } else if (!sessionId || (bindings.has(sessionId) && bindings.get(sessionId) !== input.agentId)) {
      sessionId = [...bindings].find(([, agent]) => agent === input.agentId)?.[0] || `remote-${input.agentId}`;
      rows[sessionId] ||= { id: sessionId, blank: true, cwd: '/workspace/a' };
    }
    bindings.set(sessionId, input.agentId);
    rows[sessionId].projectionValues = { modelSelection: { next: { provider: 'a2a-remote-agent', model: 'direct' } } };
    return { ok: true, value: { agentId: input.agentId, sessionId } };
  } };
  const memory = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const targets = () => ['one','two'].map(agentId => ({ agentId, sessionIds: [...bindings].filter(([, agent]) => agent === agentId).map(([id]) => id) }));
  return { ctx, remote, memory, show, calls, navigations, block, targets,
    overwriteModel(id) { rows[id].projectionValues = { modelSelection: { next: { provider: 'controller-model', model: 'local' } } }; publish(); },
    delay(fn) { delay = fn; } };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('remote default survives workspace changes, New Session and reload, while native composer waits for its binding', async t => {
  const h = host(); h.show('a');
  let selection = new RemoteSelection(h.ctx, h.remote, h.memory), stop = selection.start();
  t.after(() => stop());
  selection.setTargets(h.targets());
  await selection.select('one');
  assert.equal(selection.snapshot.agentId, 'one'); assert.equal(selection.snapshot.sessionId, 'a');
  h.show('b', { cwd: '/workspace/b' });
  assert.equal(selection.snapshot.agentId, 'one');
  assert(h.block('b').getSnapshot(), 'native input was enabled before the remote binding');
  await settled();
  assert.equal(selection.snapshot.sessionId, 'b'); assert.equal(h.block('b').getSnapshot(), undefined);
  h.show('b-new', { cwd: '/workspace/b' }); await settled();
  assert.deepEqual(h.calls.map(call => call.sessionId), ['a','b','b-new']);
  assert.equal(selection.snapshot.agentId, 'one');
  stop();
  selection = new RemoteSelection(h.ctx, h.remote, h.memory); stop = selection.start();
  selection.setTargets(h.targets()); await settled();
  assert.equal(selection.snapshot.agentId, 'one'); assert.equal(selection.snapshot.sessionId, 'b-new');
  h.show('local-history', { blank: false });
  assert.equal(selection.snapshot.agentId, null);
  assert.equal(selection.snapshot.sessionId, null);
  assert.equal(h.memory.getItem('dsh.a2a.remote-agent'), undefined);
  const count = h.calls.length;
  h.show('local-workspace', { cwd: '/workspace/c' }); await settled();
  assert.equal(h.calls.length, count, 'opening local history retained the remote default');
});

test('a slower workspace binding cannot steal newer navigation or Agent selection', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  h.delay(input => input.sessionId === 'slow' ? slow : undefined);
  h.show('slow', { cwd: '/workspace/slow' });
  h.show('fast', { cwd: '/workspace/fast' }); await settled();
  assert.equal(selection.snapshot.sessionId, 'fast');
  await selection.select('two');
  const current = selection.snapshot.sessionId;
  release(); await settled();
  assert.equal(selection.snapshot.agentId, 'two'); assert.equal(selection.snapshot.sessionId, current);
  assert.equal(h.navigations.at(-1), current);
});

test('binding failures retain the selected target and block local fallback without overwriting other composer blocks', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets());
  h.remote.open = async () => ({ ok: false, error: { message: '目标授权已撤销' } });
  const other = { reason: '另一插件的输入限制' };
  h.ctx.conversation.blocks.set('a', other);
  await selection.select('one');
  assert.equal(selection.snapshot.agentId, 'one');
  assert.equal(selection.snapshot.sessionId, null);
  assert.equal(h.block('a').getSnapshot(), other);
  h.ctx.conversation.blocks.set('a', undefined);
  assert.match(h.block('a').getSnapshot().reason, /授权已撤销/);
  selection.setTargets([]);
  assert.equal(selection.snapshot.agentId, 'one');
  assert.match(h.block('a').getSnapshot().reason, /不可访问/);
});

test('a native model picker override rebinds the same remote Session and blocks the composer until confirmed', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  h.overwriteModel('a');
  assert.equal(selection.snapshot.agentId, 'one');
  assert(h.block('a').getSnapshot(), 'native input stayed enabled with an overridden model');
  await settled();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { agentId: 'one', sessionId: 'a' });
  assert.equal(selection.snapshot.sessionId, 'a');
  assert.equal(h.block('a').getSnapshot(), undefined);
});

test('New Chat retains the selected target and opens a different native Session, and history returns to the old one', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  await selection.newChat();
  assert.equal(selection.snapshot.agentId, 'one');
  assert.equal(selection.snapshot.sessionId, 'new-1');
  assert.deepEqual(h.calls.at(-1), { agentId: 'one', sessionId: 'a', newSession: true });
  assert.equal(selection.bindings.get('a'), 'one');
  await selection.select('one', { sessionId: 'a' });
  assert.equal(selection.snapshot.sessionId, 'a');
  assert.deepEqual(h.calls.at(-1), { agentId: 'one', sessionId: 'a' });
});
