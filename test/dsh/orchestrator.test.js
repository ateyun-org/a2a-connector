import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { A2AOrchestrator, a2aTaskState, responseParts } from '../../plugins/dsh/orchestrator.js';
import { installOutbound } from '../../plugins/dsh/outbound.js';

const requests = [];
let taskState = 'TASK_STATE_WORKING';
const server = createServer(async (req, res) => {
  if (req.url === '/.well-known/agent-card.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ name: 'Remote Coder', description: 'A coding agent', version: '1.0.0',
      supportedInterfaces: [{ url: `http://127.0.0.1:${server.address().port}/rpc`,
        protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      skills: [{ id: 'code', name: 'Code', description: 'Write code', tags: ['coding'] }],
      defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], capabilities: {} }));
    return;
  }
  const body = JSON.parse(await new Promise(resolve => {
    let value = '';
    req.on('data', chunk => { value += chunk; });
    req.on('end', () => resolve(value));
  }));
  requests.push({ method: body.method, params: body.params, version: req.headers['a2a-version'] });
  const task = state => ({ id: 'remote-task-1', contextId: 'remote-context-1',
    status: { state, message: state === 'TASK_STATE_COMPLETED'
      ? { messageId: 'answer', contextId: 'remote-context-1', role: 'ROLE_AGENT',
        parts: [{ text: 'done', mediaType: 'text/plain' }] } : undefined },
    artifacts: state === 'TASK_STATE_COMPLETED' ? [{ artifactId: 'artifact-1',
      parts: [{ text: 'result', mediaType: 'text/plain' }] }] : [] });
  let result;
  if (body.method === 'SendMessage') result = { task: task(taskState) };
  else if (body.method === 'GetTask') result = task(taskState);
  else if (body.method === 'CancelTask') {
    taskState = 'TASK_STATE_CANCELED';
    result = task(taskState);
  } else if (body.method === 'ListTasks') result = { tasks: [task(taskState)], nextPageToken: '' };
  else { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

const directory = await mkdtemp(join(tmpdir(), 'dsh-a2a-test-'));
const config = { storePath: join(directory, 'conversations.json'), pollIntervalMs: 100,
  agents: [{ id: 'coder', url: `http://127.0.0.1:${server.address().port}`, allowHttp: true }] };

test('discovers a v1.0 card and completes a remote run through DSH provider contract', async () => {
  taskState = 'TASK_STATE_WORKING';
  const a2a = new A2AOrchestrator(config);
  const card = await a2a.discover('coder');
  assert.equal(card.name, 'Remote Coder');
  const controller = new AbortController();
  const run = await a2a.startRun('coder', { parent: { session: { id: 'parent-1' } },
    prompt: [{ type: 'text', text: 'Write a function' }], signal: controller.signal });
  assert.equal(run.localAgent, undefined);
  taskState = 'TASK_STATE_COMPLETED';
  const result = await run.result;
  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(result.output.slice(0, 2).map(item => item.text), ['done', 'result']);
  assert.match(result.output[2].text, /^A2A conversation ID: /);
  await run.dispose();
  assert.equal(requests.find(item => item.method === 'SendMessage').version, '1.0');
  assert.equal((await a2a.listConversations('parent-1'))[0].contextId, 'remote-context-1');
});

test('continues an input-required task with the same task and context, then cancels', async () => {
  taskState = 'TASK_STATE_INPUT_REQUIRED';
  const a2a = new A2AOrchestrator(config);
  const first = await a2a.send({ agentId: 'coder', parentId: 'parent-2',
    content: [{ type: 'text', text: 'Start research' }] });
  await a2a.send({ agentId: 'coder', parentId: 'parent-2', conversationId: first.conversation.id,
    content: [{ type: 'text', text: 'Use English sources' }] });
  const sends = requests.filter(item => item.method === 'SendMessage');
  assert.equal(sends.at(-1).params.message.taskId, 'remote-task-1');
  assert.equal(sends.at(-1).params.message.contextId, 'remote-context-1');
  await assert.rejects(() => a2a.getTask(first.conversation.id, 'other-parent'), /not found/);
  const cancelled = await a2a.cancel(first.conversation.id, 'parent-2');
  assert.equal(cancelled.state, a2aTaskState.TASK_STATE_CANCELED);
  const restored = new A2AOrchestrator(config);
  assert.equal((await restored.listConversations('parent-2'))[0].state, a2aTaskState.TASK_STATE_CANCELED);
});

test('disposing an active DSH run cancels the remote task and settles polling', async () => {
  taskState = 'TASK_STATE_WORKING';
  const a2a = new A2AOrchestrator(config);
  const run = await a2a.startRun('coder', { parent: { session: { id: 'parent-3' } },
    prompt: [{ type: 'text', text: 'Long job' }], signal: new AbortController().signal });
  await run.dispose();
  assert.equal((await run.result).stopReason, 'aborted');
  assert.equal((await a2a.listConversations('parent-3'))[0].state, a2aTaskState.TASK_STATE_CANCELED);
});

test('rejects card interface outside the configured origin', async () => {
  const a2a = new A2AOrchestrator({ ...config, agents: [{ id: 'bad', url: config.agents[0].url,
    allowHttp: true }] }, { fetchImpl: async (input, init) => {
    if (String(input).includes('agent-card')) return new Response(JSON.stringify({ name: 'Bad',
      supportedInterfaces: [{ url: 'http://attacker.invalid/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
    return fetch(input, init);
  } });
  await assert.rejects(() => a2a.discover('bad'), /no allowed A2A v1.0/);
});

test('registers a DSH provider and exposes its purpose to the controller', async () => {
  const providers = [];
  const tools = [];
  const described = { ...config, agents: config.agents.map(agent => ({ ...agent,
    purpose: 'Reviews Go and Node.js code', whenToUse: 'Use for code review', notFor: 'Do not use for deployment' })) };
  const a2a = installOutbound({ subagents: { registerProvider: provider => providers.push(provider) },
    tools: { register: definition => tools.push(definition) } }, described);
  assert.equal(providers[0].name, 'a2a:coder');
  assert.equal(providers[0].capabilities.depthLimit, false);
  assert.deepEqual(tools.map(tool => tool.name),
    ['a2a_agents', 'a2a_send', 'a2a_task', 'a2a_cancel', 'a2a_conversations']);
  assert.match(tools[0].description, /coder: Reviews Go and Node.js code/);
  assert.match(tools[1].description, /coder: Reviews Go and Node.js code/);
  const [agent] = await a2a.listAgents();
  assert.equal(agent.purpose, 'Reviews Go and Node.js code');
  assert.equal(agent.whenToUse, 'Use for code review');
  assert.equal(agent.notFor, 'Do not use for deployment');
  assert.equal(agent.description, 'A coding agent');
  assert.equal(agent.skills[0].description, 'Write code');
});

test('accepts a full relay Agent Card URL as registry entry', async () => {
  const port = server.address().port;
  const relay = new A2AOrchestrator({ ...config, agents: [{ id: 'relay-coder',
    card: `http://127.0.0.1:${port}/.well-known/agent-card.json`, allowHttp: true }] });
  assert.equal((await relay.discover('relay-coder')).name, 'Remote Coder');
});


test('automatically uses paired controller credentials and reloads rotated credentials', async () => {
  const connectorState = join(directory, 'paired.json');
  const enrollment = { agentId: 'dsh', token: 'agt_dsh.first',
    card: 'https://relay.example/agents/dsh/.well-known/agent-card.json' };
  const seen = [];
  const paired = new A2AOrchestrator({ ...config, connectorState,
    agents: [{ id: 'coder', card: 'https://relay.example/agents/coder/.well-known/agent-card.json',
      tokenEnv: 'UNSET_TEST_RELAY_TOKEN', allowedOrigins: ['https://other.example'] }] }, {
    fetchImpl: async (input, init) => {
      seen.push(init.headers.get('Authorization'));
      return new Response(JSON.stringify({ name: 'Coder', supportedInterfaces: [{
        url: 'https://relay.example/agents/coder/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0'
      }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  await writeFile(connectorState, JSON.stringify(enrollment));
  await paired.discover('coder');
  enrollment.token = 'agt_dsh.rotated';
  await writeFile(connectorState, JSON.stringify(enrollment));
  await paired.discover('coder', { refresh: true });
  assert.deepEqual(seen, ['Bearer agt_dsh.first', 'Bearer agt_dsh.rotated']);
  enrollment.card = 'https://another-relay.example/agents/dsh/.well-known/agent-card.json';
  await writeFile(connectorState, JSON.stringify(enrollment));
  await assert.rejects(() => paired.discover('coder', { refresh: true }), /another Relay/);
  assert.equal(seen.length, 2);
});

test('deduplicates response parts when status message and artifacts contain identical content', () => {
  const duplicateTask = {
    status: {
      message: {
        role: 'ROLE_AGENT',
        parts: [
          { content: { $case: 'text', value: 'item 1\nitem 2' }, mediaType: 'text/plain' },
        ],
      },
    },
    artifacts: [
      {
        artifactId: 'artifact-1',
        parts: [
          { content: { $case: 'text', value: 'item 1\nitem 2' }, mediaType: 'text/plain' },
          { content: { $case: 'text', value: 'additional artifact' }, mediaType: 'text/plain' },
        ],
      },
      {
        artifactId: 'artifact-2',
        parts: [
          { content: { $case: 'text', value: 'item 1\nitem 2' }, mediaType: 'text/plain' },
        ],
      },
    ],
  };

  const parts = responseParts(duplicateTask);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].content.value, 'item 1\nitem 2');
  assert.equal(parts[1].content.value, 'additional artifact');
});

test('Relay authentication diagnostics survive discovery without leaking response bodies', async () => {
  for (const [body, expected] of [
    [{ error: 'not_controller', agentId: 'local-dsh', token: 'TOP_SECRET' }, /not_controller.*local-dsh.*pair\/list/],
    [{ error: 'unauthorized', message: 'TOP_SECRET' }, /unauthorized.*401/],
    ['TOP_SECRET', /unauthorized.*401/],
  ]) {
    const a2a = new A2AOrchestrator({ ...config, connectorState: join(directory, 'absent.json'),
      agents: [{ id: 'coder', card: 'https://relay.example/agents/coder/.well-known/agent-card.json' }] },
    { fetchImpl: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 401 }) });
    await assert.rejects(() => a2a.discover('coder'), expected);
    const [listed] = await a2a.listAgents();
    assert.equal(listed.available, false);
    assert.match(listed.diagnostic, expected);
    assert.doesNotMatch(listed.diagnostic, /TOP_SECRET/);
  }
});

test('Relay target grant denial identifies the paired controller without leaking credentials', async () => {
  const a2a = new A2AOrchestrator({ ...config, connectorState: join(directory, 'absent.json'),
    agents: [{ id: 'coder', card: 'https://relay.example/agents/coder/.well-known/agent-card.json' }] },
  { fetchImpl: async () => new Response(JSON.stringify({ error: 'access_denied', agentId: 'local-dsh', token: 'TOP_SECRET' }), { status: 403 }) });
  await assert.rejects(() => a2a.discover('coder'), /access_denied.*local-dsh.*pair\/list/);
  const [listed] = await a2a.listAgents();
  assert.equal(listed.available, false);
  assert.doesNotMatch(listed.diagnostic, /TOP_SECRET/);
});

test('Relay not_controller stays readable when a controller is revoked during task polling', async () => {
  let revoked = false;
  const a2a = new A2AOrchestrator({ ...config, connectorState: join(directory, 'absent.json'),
    agents: [{ id: 'coder', card: 'https://relay.example/agents/coder/.well-known/agent-card.json' }] }, {
    fetchImpl: async () => revoked
      ? new Response(JSON.stringify({ error: 'not_controller', agentId: 'local-dsh' }), { status: 401 })
      : new Response(JSON.stringify({ name: 'Coder', supportedInterfaces: [{ url: 'https://relay.example/agents/coder/rpc',
        protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }), { headers: { 'content-type': 'application/json' } }),
  });
  await a2a.discover('coder');
  const conversation = { id: 'revoked-task', parentId: 'parent', agentId: 'coder', taskId: 'remote', state: 'TASK_STATE_WORKING' };
  await a2a.store.put(conversation);
  revoked = true;
  const outcome = await a2a.waitForResult(conversation, { status: { state: 'TASK_STATE_WORKING' } });
  assert.equal(outcome.stopReason, 'error');
  assert.match(outcome.diagnostic, /not_controller.*pair\/list/);
});
