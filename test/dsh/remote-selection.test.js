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
  const rows = {}, bindings = new Map(), calls = [], navigations = [], blocks = new Map(), storage = new Map(), archives = [];
  let active, navigation, opened = 0, delay, archiveDelay, archiveError, retainArchived = false;
  const list = store({ byId: {} });
  const workspaceList = store({ archivedSessionIds: [] });
  function publish() { list.set({ byId: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, { ...row, retainedBy: id === active ? { mainView: 1 } : {} }])) }); }
  function show(id, { blank = true, cwd = '/workspace/a' } = {}) {
    if (!rows[id]) rows[id] = { id, blank, cwd };
    active = id; ctx.layout.beginNavigation(); publish();
  }
  const block = id => { if (!blocks.has(id)) blocks.set(id, store(undefined)); return blocks.get(id); };
  const ctx = {
    sessions: { list, async refresh() { publish(); }, async create({ cwd } = {}) { const id = `local-${++opened}`; rows[id] = { id, cwd, blank: true }; publish(); return id; } },
    workspaces: { list: workspaceList },
    layout: { beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; }, selectPanel() { navigation?.abort(); } },
    uiWorkspace: { openSession(id) { navigations.push(id); show(id); }, async archiveSession(id) {
      archives.push(id);
      if (archiveError) throw archiveError;
      await archiveDelay?.(id);
      workspaceList.set({ archivedSessionIds: [...workspaceList.getSnapshot().archivedSessionIds, id] });
      if (active === id && !retainArchived) { active = undefined; publish(); ctx.layout.selectPanel(null); }
    } },
    conversation: { blocks: { storeFor: block, set(id, value) { block(id).set(value); } } },
  };
  const remote = { async open(input) {
    calls.push(input);
    const wait = delay?.(input);
    if (wait) await wait;
    let sessionId = input.sessionId;
    if (!input.newSession && workspaceList.getSnapshot().archivedSessionIds.includes(sessionId)) {
      return { ok: false, error: { message: '此聊天已移至归档' } };
    }
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
  return { ctx, remote, memory, show, calls, navigations, block, targets, archives,
    overwriteModel(id) { rows[id].projectionValues = { modelSelection: { next: { provider: 'controller-model', model: 'local' } } }; publish(); },
    delay(fn) { delay = fn; },
    delayArchive(fn) { archiveDelay = fn; },
    failArchive(error) { archiveError = error; },
    retainArchived(value) { retainArchived = value; } };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('native workspace, New Session and history navigation exit remote mode; reload restores only the current Session binding', async t => {
  const h = host(); h.show('a');
  let selection = new RemoteSelection(h.ctx, h.remote, h.memory), stop = selection.start();
  t.after(() => stop());
  selection.setTargets(h.targets());
  await selection.select('one');
  assert.equal(selection.snapshot.agentId, 'one'); assert.equal(selection.snapshot.sessionId, 'a');
  h.show('b', { cwd: '/workspace/b' });
  await settled();
  assert.equal(selection.snapshot.agentId, null);
  assert.equal(selection.snapshot.sessionId, null); assert.equal(h.block('b').getSnapshot(), undefined);
  h.show('b-new', { cwd: '/workspace/b' }); await settled();
  assert.deepEqual(h.calls.map(call => call.sessionId), ['a']);
  assert.equal(selection.snapshot.agentId, null);
  h.memory.setItem('dsh.a2a.remote-agent', 'one');
  stop();
  selection = new RemoteSelection(h.ctx, h.remote, h.memory); stop = selection.start();
  selection.setTargets(h.targets()); await settled();
  assert.equal(selection.snapshot.agentId, null); assert.equal(selection.snapshot.sessionId, null);
  assert.equal(h.memory.getItem('dsh.a2a.remote-agent'), undefined);
  h.show('a');
  assert.equal(selection.snapshot.agentId, 'one'); assert.equal(selection.snapshot.sessionId, 'a');
  stop();
  selection = new RemoteSelection(h.ctx, h.remote, h.memory); stop = selection.start();
  assert(h.block('a').getSnapshot(), 'remote history was enabled before binding discovery');
  selection.setTargets(h.targets()); await settled();
  assert.equal(selection.snapshot.agentId, 'one'); assert.equal(selection.snapshot.sessionId, 'a');
  assert.equal(h.block('a').getSnapshot(), undefined);
  const count = h.calls.length;
  for (const [id, blank] of [['local-history', false], ['local-blank', true], ['local-stale-metadata', null]]) {
    h.show(id, { blank, cwd: '/workspace/c' });
    selection.setTargets(h.targets()); await settled();
    assert.equal(selection.snapshot.agentId, null);
    assert.equal(selection.snapshot.pending, false);
    assert.equal(h.block(id).getSnapshot(), undefined);
    assert.equal(h.calls.length, count, 'native navigation rebound a local chat to a remote Agent');
  }
});

test('a slower explicit remote selection cannot steal newer native navigation or Agent selection', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  h.show('slow', { cwd: '/workspace/slow' });
  h.delay(input => input.sessionId === 'slow' ? slow : undefined);
  const pending = selection.select('one');
  h.show('fast', { cwd: '/workspace/fast' }); await settled();
  assert.equal(selection.snapshot.agentId, null);
  assert.equal(selection.currentSession().id, 'fast');
  await selection.select('two');
  const current = selection.snapshot.sessionId;
  release(); await pending; await settled();
  assert.equal(selection.snapshot.agentId, 'two'); assert.equal(selection.snapshot.sessionId, current);
  assert.equal(h.navigations.at(-1), current);
});

test('native New Session reusing the same local blank cancels an unfinished remote selection immediately', async t => {
  for (const action of ['select', 'newChat']) await t.test(action, async t => {
    const h = host(); h.show('local-blank');
    const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
    selection.setTargets(h.targets());
    let release;
    h.delay(() => new Promise(resolve => { release = resolve; }));
    const connection = selection[action]('one');
    assert.equal(selection.snapshot.pending, true);
    assert(h.block('local-blank').getSnapshot());
    h.show('local-blank'); // Native New Session can retain the same Session id.
    assert.equal(selection.snapshot.agentId, null);
    assert.equal(selection.snapshot.pending, false);
    assert.equal(h.block('local-blank').getSnapshot(), undefined);
    release(); await connection;
    assert.equal(selection.snapshot.agentId, null);
    assert.equal(selection.currentSession().id, 'local-blank');
    assert.equal(h.navigations.length, 0, 'late remote reply stole the native selection');
  });
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

test('removing the current last chat opens a fresh remote chat in the same workspace after native navigation clears', async t => {
  const h = host(); h.show('a', { cwd: '/workspace/last-chat' });
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  assert.equal(await selection.archive('a'), true);
  assert.deepEqual(h.archives, ['a']);
  assert.deepEqual(h.calls.at(-1), { agentId: 'one', sessionId: 'a', newSession: true });
  assert.equal(selection.snapshot.sessionId, 'new-1');
  assert.equal(selection.snapshot.agentId, 'one');
  assert.equal(selection.snapshot.pending, false);
  const fresh = selection.currentSession();
  assert.equal(fresh.id, 'new-1');
  assert.equal(fresh.cwd, '/workspace/last-chat');
  assert.equal(fresh.blank, true);
  assert.equal(fresh.projectionValues.modelSelection.next.provider, 'a2a-remote-agent');
  assert.equal(h.block(fresh.id).getSnapshot(), undefined);
});

test('removing an inactive chat or refusing archival preserves the current conversation', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one'); await selection.newChat();
  const count = h.calls.length;
  assert.equal(await selection.archive('a'), false);
  assert.equal(selection.currentSession().id, 'new-1');
  assert.equal(h.calls.length, count);
  h.failArchive(new Error('archive refused'));
  await assert.rejects(selection.archive('new-1'), /archive refused/);
  assert.equal(selection.currentSession().id, 'new-1');
  assert.equal(h.calls.length, count);
  assert(!h.ctx.workspaces.list.getSnapshot().archivedSessionIds.includes('new-1'));
});

test('archival completion cannot replace a newer native workspace, local history or remote Agent selection', async t => {
  for (const route of ['workspace', 'local', 'agent']) await t.test(route, async t => {
    const h = host(); h.show('a');
    const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
    selection.setTargets(h.targets()); await selection.select('one');
    let release;
    h.delayArchive(() => new Promise(resolve => { release = resolve; }));
    const removal = selection.archive('a');
    if (route === 'agent') await selection.select('two');
    else { h.show('new-navigation', { blank: route !== 'local', cwd: '/workspace/new' }); await settled(); }
    const current = selection.currentSession().id, count = h.calls.length;
    release();
    assert.equal(await removal, false);
    assert.equal(selection.currentSession().id, current);
    assert.equal(h.calls.length, count);
  });
});

test('target selection and New Chat work while native retention still lists an archived mainView', async t => {
  const h = host(); h.show('a');
  const selection = new RemoteSelection(h.ctx, h.remote, h.memory); t.after(selection.start());
  selection.setTargets(h.targets()); await selection.select('one');
  h.retainArchived(true);
  await h.ctx.uiWorkspace.archiveSession('a');
  await selection.select('one');
  assert.equal(selection.snapshot.sessionId, 'new-1');
  assert.deepEqual(h.calls.at(-1), { agentId: 'one', sessionId: 'a', newSession: true });
  await h.ctx.uiWorkspace.archiveSession('new-1');
  await selection.newChat('one');
  assert.equal(selection.snapshot.sessionId, 'new-2');
  assert.equal(selection.currentSession().projectionValues.modelSelection.next.provider, 'a2a-remote-agent');
});
