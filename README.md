# a2a-connector

Node.js 22+ outbound A2A tunnel client. The Connector discovers a local Agent Card, connects to the GoFrame Relay over WSS, and forwards A2A HTTP traffic. The implementation is JavaScript; the four host plugins contain a generated copy of the same source. Hermes needs a small Python registration shim because its native plugin API is Python.

## Install and test

```bash
npm ci
npm test
```

The default suite needs only root dependencies and is suitable for Hermes/Connector installation checks. It includes the SDK-independent adapter protocol tests and package checks. DSH native driver tests have a separate, mandatory CI step:

```bash
npm ci --prefix plugins/dsh
npm run test:all
```

`test:dsh` runs only the native DSH suite and fails if its SDK dependencies are missing; tests are never silently skipped.

## Enroll and run

An organization owner/admin first creates or selects an Agent in the Relay console and issues a ticket. Supply the ticket privately as `A2A_PAIR_CODE`, then run the installer with `--expect-agent-id` using that Agent's public ID:

```bash
rtk proxy sh scripts/install-connector.sh install --host openclaw \
  --expect-agent-id AGENT_ID_FROM_CONSOLE \
  --relay wss://YOUR_RELAY/connect --local http://127.0.0.1:9900 \
  --expect-name 'ACTUAL_AGENT_CARD_NAME'
```

The script supports `workbuddy`, `openclaw`, `hermes` and `dsh` after the local A2A service is running. It redeems the ticket once at `/register`, saves private credentials, removes the ticket from the tunnel process environment, and starts the connection. Matching saved credentials are reused; another Agent's state is preserved and rejected. No legacy pairing request or approval polling is used. Use the existing `--instance`/`--state` for restarts, and clear `A2A_PAIR_CODE` in the calling environment after installation. See [installation and recovery](docs/install/shared.md#票据接入).

OpenClaw hosts can run `node scripts/install-openclaw.mjs`: it detects the host's A2A capabilities and installs only the Connector when native A2A exists, or includes the compatibility service when absent. The plugin defaults to `local: "auto"` and rechecks capabilities at startup. Disabled/broken native A2A requires repair rather than installing a second service. See [OpenClaw installation](docs/install/openclaw.md) for native peer authentication and older CLI requirements.

Hermes hosts can use `python3 scripts/install-hermes.py --hermes-python /path/to/hermes/.venv/bin/python`. It inspects the actual host installation and includes compatibility A2A only when native A2A is absent. The plugin defaults to `A2A_LOCAL_URL=auto`, reuses native A2A when available, and uses isolated quiet CLI sessions otherwise. See [Hermes installation](docs/install/hermes.md) for profiles, native authentication and older CLI requirements.

Hermes also ships [the Relay calling skill](plugins/hermes/skills/relay-calling/SKILL.md), registered as `a2a-connector:relay-calling`. Load it explicitly before delegation; it covers enterprise permission direction, direct HTTP when host tools are unavailable, valid message envelopes, owned-task reads and durable receipts. WorkBuddy CLI/MCP skills carry the same enterprise boundaries through their respective clients. Updating source does not update an already installed plugin or load the new skill into an existing remote session.

OpenClaw ships [a2a-relay-calling](plugins/openclaw/skills/a2a-relay-calling/SKILL.md), declared in its plugin manifest and included in both native and compatibility installations. Hermes and OpenClaw package their HTTP references from [the shared Relay protocol](docs/relay-http.md); run `rtk proxy node scripts/sync-plugins.mjs` after protocol changes so both stay current.

DSH's native outbound tool descriptions and [packaged calling skill](plugins/dsh/skills/a2a-relay-calling/SKILL.md) cover the same enterprise rules; its HTTP reference also comes from the shared source. See [the complete distribution/loading inventory](plugins/README.md#relay-instruction-coverage) for all five host/client packages and the standalone CLI.

DSH hosts can use one `dsh-a2a-connector` entry, which starts its bundled native A2A service and Relay Connector together and registers outbound A2A delegation when `agents` are configured; see [DSH installation and service setup](docs/install/dsh.md). After `auth enroll`, WorkBuddy's `workbuddy-a2a setup --relay <url>` starts its built-in PC adapter and Connector together; add `--mode cloud` for cloud Open API + ACP execution; see [WorkBuddy setup and OAuth](docs/install/workbuddy.md). For an independently managed A2A origin, first obtain an Agent ticket in `/console` and provide it privately through `A2A_PAIR_CODE`:

```bash
rtk proxy node src/cli.js -enroll-only -agent-id AGENT_ID_FROM_CONSOLE \
  -relay wss://YOUR_RELAY/connect -state /private/path/agent.json
# Clear A2A_PAIR_CODE in the calling environment after enrollment.
rtk proxy node src/cli.js -relay wss://YOUR_RELAY/connect \
  -local http://127.0.0.1:9900 -state /private/path/agent.json
```

The Relay requires MySQL organization authorization. Shared tokens, global pairing approvals and Redis-only identities are removed. A Connector starts only with an existing per-Agent credential; a missing credential fails before networking. Startup never creates an approval request or redeems a ticket implicitly. Host pair tools redeem an explicitly supplied console ticket, or report enrollment_required. Use the same state across restarts.

CLI options (also supported by the copies in `plugins/*/vendor/connector/cli.js`):

| Option | Purpose |
| --- | --- |
| `-relay <wss://host/connect>` | Relay WSS URL; required for network operations. |
| `-local <http://127.0.0.1:port>` | Local A2A origin, without an endpoint path; required for discovery and forwarding. |
| `-enroll-only` | With private `A2A_PAIR_CODE`, redeem exactly once, save the credential, and exit without connecting. |
| `-status` | Read process/tunnel health for `-state` as JSON, without exposing credentials or requiring network arguments. |
| `-max-request-body <bytes>` | Limit incoming request buffering to 1–16777216 bytes; default 16 MiB. DSH's bundled adapter uses 1 MiB. |
| `-state <private-file>` | Private credential path. |
| `-agent-id <id>` | Expected public Agent ID from the console; reject a mismatched saved/redemption identity. |
| `-local-token <secret>` | Bearer token for the local origin; prefer `A2A_LOCAL_TOKEN` in the process environment. |
| `-token <secret>` | Existing Relay Connector credential; prefer the private state file or `A2A_CONNECTOR_TOKEN`. |
| `-allow-insecure` | Permit `ws://` **to the Relay** for local tests; local `http://` origins do not require it. |

The credentials are stored in private `0600` files under the OS user config directory; use `-state` to choose another path. Set `A2A_LOCAL_TOKEN` if the local Agent requires a Bearer token. The canonical state path owns an atomic `<state>.lock` directory. Its `owner.json` identifies the process without credentials; normal shutdown releases the lock, while crash leftovers fail closed. The private `<state>.status.json` holds a token-free health snapshot, refreshed every 15 seconds. `-status` combines snapshot freshness, instance identity and process liveness; DSH/OpenClaw expose it as `a2a_connector_status` with a bounded recent log buffer. Agent Card availability is outbound HTTPS reachability and does not establish inbound WSS health. The Connector pings every 25 seconds and reconnects with exponential backoff. Bodies are capped at 16 MiB and buffered; SSE streaming is not yet implemented.

## Host plugins

For Buddy application binding, `plugins/workbuddy-mcp` supplies the remote OAuth MCP connector. It exposes authorized A2A tools through the Relay's `/mcp`, with no client runtime or app secret in its package. WorkBuddy's [hosted receiving service](docs/install/workbuddy-hosted.md) can run multiple isolated identities on a shared server and route each identity to official cloud/PC APIs; the user's PC needs no A2A/Connector process. The existing `plugins/workbuddy` CLI remains the single-mode receiving adapter and diagnostic path. See [application binding, private server configuration and deployment](docs/install/workbuddy-mcp.md). Marketplace review, real account grants and deployment are separate from local protocol tests.

`plugins/openclaw`, `plugins/dsh`, and `plugins/workbuddy` are JavaScript integrations. `plugins/hermes` is a thin Python entry point that launches the same JavaScript client. Before installing or packing a plugin from this source tree, run:

```bash
node scripts/sync-plugins.mjs
```

That command refreshes the checked-in copy of the canonical `src/` client in each plugin's `vendor/` directory. It also includes the `ws` dependency for Hermes, whose plugin installer does not install Node dependencies. OpenClaw and DSH install `ws` from their package manifests; the documented WorkBuddy CLI path uses `npm ci --prefix plugins/workbuddy`. WorkBuddy GUI marketplace discovery is not yet verified for this package layout. See [plugins/README.md](plugins/README.md) for package maintenance and the [installation index](AGENT_INSTALL.md) for host configuration.

## Version management

To bump the version across `a2a-connector` and all host plugins in one command:

```bash
./bump-version.sh 0.2.2
# or bump semver automatically:
./bump-version.sh patch
./bump-version.sh minor
./bump-version.sh major
# preview without writing:
./bump-version.sh --dry-run patch
```

You can also run `npm run bump-version -- <version|patch|minor|major>`. This synchronizes:

- `package.json` and `package-lock.json` in root and all plugins (`openclaw`, `dsh`, `workbuddy`)
- Host metadata files (`plugins/workbuddy/connector-meta.json` and `plugins/hermes/plugin.yaml`)

For host-specific installation and pairing procedures, start at the [installation index](AGENT_INSTALL.md).
