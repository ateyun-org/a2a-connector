# Connector host plugins

The four host packages run the same JavaScript Connector. Their checked-in `vendor/` copies include the client source; Hermes also vendors `ws` under `vendor/connector/node_modules/`. After changing `src/`, run `rtk npm ci` and `rtk node scripts/sync-plugins.mjs` from `a2a-connector/` to refresh those copies before packing. The Agent must already expose a local A2A HTTP endpoint and Agent Card; if it does not, add an A2A adapter beside the Connector. For agent-driven installation, see [AGENT_INSTALL.md](../AGENT_INSTALL.md).

On startup, a plugin without a credential automatically requests pairing and waits for approval. Ask the Agent to use its `a2a_connector_pair` tool without a code to show the confirmation code and approval page. The Relay administrator compares that code at `/pair` and approves. The plugin then registers, saves the credential privately, and connects. Approving an existing `agentId` rotates its old credential; the page warns about this. The older one-time `pair_` code flow remains available by passing a code to the tool.

## OpenClaw

Install `plugins/openclaw` as a local OpenClaw plugin. Set `plugins.entries.a2a-connector.config` with `relay` (`wss://.../connect`) and `local` (`http://127.0.0.1:<port>`). The optional keys are `agentId`, `binary` (Node.js executable), `state`, `localTokenEnv`, and `allowInsecure`. Ask the Agent to show its pairing request with `a2a_connector_pair`. The Gateway service runs the Connector on later restarts.

## Hermes

Install the full `plugins/hermes` directory under `~/.hermes/plugins/a2a-connector/` (or the active Hermes home when `HERMES_HOME` is set); do not run `rtk npm ci` there because the Hermes copy already contains `ws`. Node.js 22+ must be available to the Gateway process. This is a standalone tool/Hook plugin, so enable it with `rtk hermes plugins enable a2a-connector`, then restart and check the target Gateway with `rtk hermes gateway restart` and `rtk hermes gateway status`. Add `-p <profile>` to both commands only for a named standalone profile; a multiplexed profile uses the shared default Gateway. Set `A2A_RELAY_URL` and `A2A_LOCAL_URL` in the environment file read by that Gateway, normally `~/.hermes/.env`; `A2A_LOCAL_TOKEN` takes the token value itself. `A2A_NODE_BINARY` can point to an absolute Node path when the service PATH does not include Node. `A2A_CONNECTOR_STATE` defaults to `~/.config/a2a-connector/hermes.json`; set a distinct path for each independent Connector instance. Do not add `Environment=` directly to Hermes' generated systemd unit; use Hermes' `.env` or a systemd drop-in with `EnvironmentFile=`. Use `/a2a_connector pair` or ask the Agent to call `a2a_connector_pair` to show or refresh pairing details. `/a2a_connector start` and `/a2a_connector stop` manage the background process.

## DSH

Install `plugins/dsh` as a separate DSH plugin alongside `dsh-a2a`. Configure `relay` and `local` in its Cordis config. Optional keys match OpenClaw. Ask DSH to show the approval details using `a2a_connector_pair`; Cordis starts and stops the Connector with the plugin lifecycle. This plugin is for a remote DSH Agent; the central `dsh-a2a` project remains the Orchestrator's A2A client.

## Tencent WorkBuddy

`plugins/workbuddy` follows WorkBuddy's CLI + Skill connector layout. It includes `connector-meta.json`, `cli.json`, `icon.svg`, a CLI, and an Agent skill. WorkBuddy supplies the declared Node.js runtime. `workbuddy-a2a auth login` asks for the Relay URL and local A2A origin, then shows the approval link and confirmation code. `auth status` shows pending approval or the connected identity; `auth logout` stops the local Connector and clears its local state. Public marketplace distribution requires WorkBuddy review.
