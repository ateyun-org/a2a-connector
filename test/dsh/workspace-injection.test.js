import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '../../plugins/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { TypertRegistry } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/index.js';
import { TypertGatewayService } from '../../plugins/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js';
import { installRemoteAgents } from '../../plugins/dsh/remote-sessions.js';
import { ConversationStore } from '../../plugins/dsh/store.js';

test('workspace repair uses optional services across real Cordis plugin scopes and survives late loading and unload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-injection-'));
  const forks = [];
  t.after(async () => {
    for (const fork of forks.reverse()) await fork.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'bindings.json');
  await new ConversationStore(path).put({ id: 'native:remote-blank', sessionId: 'remote-blank',
    agentId: 'remote', cwd: root, updatedAt: new Date().toISOString() });
  const ctx = new Context();
  const registry = ctx.plugin(TypertRegistry); forks.push(registry); await registry;
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  const gateway = ctx.plugin(TypertGatewayService, {}); forks.push(gateway); await gateway;
  const session = { id: 'remote-blank', header: { cwd: root } };
  const agent = { session, model: { current: () => ({ provider: 'a2a-remote-agent', model: 'direct' }) } };
  const core = ctx.plugin(scope => {
    scope.provide('llm', { registerAdapter() {} });
    scope.provide('agents', { get: id => id === session.id ? agent : undefined });
    scope.provide('sessions', { get: id => id === session.id ? session : undefined, async flush() {} });
  }); forks.push(core); await core;
  let pluginScope;
  const connector = ctx.plugin({
    inject: ['llm', 'agents', 'sessions'],
    async apply(scope) {
      pluginScope = scope;
      await installRemoteAgents(scope, { syncRelayTargets: async () => [{ agentId: 'remote', online: true }] }, path);
    },
  }); forks.push(connector); await connector;
  const lifetime = new AbortController(); t.after(() => lifetime.abort());
  const peer = { id: 'workspace-owner', ctx, principal: { kind: 'owner' }, signal: lifetime.signal,
    interactions: 'none', dispose: async () => {} };
  const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'a2aControl', method, args, peer });
  const expected = [{ agentId: 'remote', online: true, sessionId: session.id, sessionIds: [session.id] }];
  assert.deepEqual(await invoke('targets', {}), expected, 'headless control required workspace services');

  const workspace = { id: 'workspace-injection', path: root, sessionIds: [session.id] };
  const workspaceRegistry = { archivedSessionIds: [], resolveByPath: async () => workspace };
  const items = [{ sessionId: session.id, cwd: root, blank: true, running: false }];
  const creates = [];
  const workspaceProvider = ctx.plugin(scope => {
    scope.provide('workspaceRegistry', workspaceRegistry);
    scope.provide('sessionController', {
      async list() { return { items }; },
      async create(input) {
        creates.push(input);
        items.unshift({ sessionId: 'local-blank', cwd: root, blank: true, running: false });
        workspace.sessionIds.push('local-blank');
        return { sessionId: 'local-blank' };
      },
    });
  }); forks.push(workspaceProvider); await workspaceProvider;
  assert.throws(() => pluginScope.workspaceRegistry, /without inject/, 'fixture bypassed Cordis injection checks');
  assert.equal(pluginScope.get('workspaceRegistry'), workspaceRegistry);
  assert.deepEqual(await invoke('targets', {}), expected);
  assert.deepEqual(creates, [{ workspaceId: workspace.id }]);
  assert.deepEqual(await invoke('open', { input: { agentId: 'remote', sessionId: session.id } }),
    { agentId: 'remote', sessionId: session.id });
  assert.equal(creates.length, 1, 'opening the remote chat duplicated a reusable local blank');
  await workspaceProvider.dispose();
  assert.deepEqual(await invoke('targets', {}), expected, 'optional workspace unload broke the controller');
});
