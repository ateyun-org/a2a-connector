# Connector host plugins

The four host packages run the same JavaScript Connector. Their checked-in `vendor/` copies make source installs self-contained. After changing `src/`, run `npm ci` and `node scripts/sync-plugins.mjs` from `a2a-connector/` to refresh those copies before packing. The Agent must already expose a local A2A HTTP endpoint and Agent Card; if it does not, add an A2A adapter beside the Connector.

The Relay administrator first calls `POST /admin/invitations` with a unique `agentId`. Give the returned `pair_` code to the remote Agent. A plugin redeems it once at `POST /register`, saves the Agent credential in its own private state file, and starts the outbound Connector. Repeating the flow for the same ID rotates the old credential.

## OpenClaw

Install `plugins/openclaw` as a local OpenClaw plugin. Set `plugins.entries.a2a-connector.config` with `relay` (`wss://.../connect`) and `local` (`http://127.0.0.1:<port>`). The optional keys are `binary` (Node.js executable), `state`, `localTokenEnv`, and `allowInsecure`. Ask the Agent to pair with the code; it uses `a2a_connector_pair`. The Gateway service starts the Connector on later restarts.

## Hermes

Install `plugins/hermes` under `~/.hermes/plugins/a2a-connector/`. Node.js 22+ must be available on the Hermes machine. Set `A2A_RELAY_URL` and `A2A_LOCAL_URL` in the Hermes process environment. Optional overrides are `A2A_NODE_BINARY`, `A2A_CONNECTOR_STATE`, `A2A_LOCAL_TOKEN`, and `A2A_ALLOW_INSECURE=1`. Use `/a2a_connector pair <code>` or ask the Agent to call `a2a_connector_pair`. `/a2a_connector start` and `/a2a_connector stop` manage the background process.

## DSH

Install `plugins/dsh` as a separate DSH plugin alongside `dsh-a2a`. Configure `relay` and `local` in its Cordis config. Optional keys match OpenClaw. Ask DSH to pair using `a2a_connector_pair`; Cordis starts and stops the Connector with the plugin lifecycle. This plugin is for a remote DSH Agent; the central `dsh-a2a` project remains the Orchestrator's A2A client.

## Tencent WorkBuddy

`plugins/workbuddy` follows WorkBuddy's CLI + Skill connector layout. It includes `connector-meta.json`, `cli.json`, `icon.svg`, a CLI, and an Agent skill. WorkBuddy supplies the declared Node.js runtime. The WorkBuddy login flow runs `workbuddy-a2a auth login` and prompts for the Relay URL, local A2A origin, and pairing code. `auth status` is read-only; `auth logout` stops the local Connector and clears the local credentials. Public marketplace distribution requires WorkBuddy review.
