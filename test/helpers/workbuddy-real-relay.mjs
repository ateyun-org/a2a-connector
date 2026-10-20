// Integration fixture: real Connector + cloud bridge, with only WorkBuddy mocked.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connector } from '../../src/connector.js';
import { CloudBridge } from '../../plugins/workbuddy/cloud-bridge.js';
import { createWorkBuddyAdapter } from '../../plugins/workbuddy/adapter-server.js';
import { TaskStore } from '../../plugins/workbuddy/task-store.js';
import { platformAccessToken } from '../../plugins/workbuddy/platform-client.js';
import { cloudProvider } from './workbuddy-cloud.js';

const relay = process.env.WB_TEST_RELAY;
const token = process.env.WB_TEST_TOKEN;
if (!relay || !token) throw new Error('Integration fixture requires private test enrollment');
const cleanup = [];
const provider = await cloudProvider({ after: fn => cleanup.push(fn) });
provider.api.accessToken = () => platformAccessToken({ relay, allowInsecure: true,
  enrollment: { agentId: 'workbuddy-cloud', token } });
const directory = await mkdtemp(join(tmpdir(), 'workbuddy-real-relay-'));
const bridge = new CloudBridge({ ...provider, store: new TaskStore(join(directory, 'tasks.json')) });
await bridge.start();
const localToken = 'integration-local-secret'.repeat(3);
const adapter = createWorkBuddyAdapter({ token: localToken, bridge, name: 'WorkBuddy Cloud Integration' });
await new Promise(resolve => adapter.server.listen(0, '127.0.0.1', resolve));
const connector = new Connector({ relay, token, allowInsecure: true,
  local: `http://127.0.0.1:${adapter.server.address().port}`, localToken });
const abort = new AbortController();
const connected = connector.connectOnce(abort.signal);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  abort.abort();
  await connected.catch(() => {});
  await adapter.close();
  for (const callback of cleanup.reverse()) await callback();
  await rm(directory, { recursive: true, force: true });
}
process.once('SIGTERM', () => close().then(() => process.exit(0)));
process.once('SIGINT', () => close().then(() => process.exit(0)));
console.log(JSON.stringify({ ready: true }));
await connected;
if (!closing) { await close(); process.exitCode = 1; }
