# a2a-connector

Node.js 22+ outbound A2A tunnel client. The Connector discovers a local Agent Card, connects to the GoFrame Relay over WSS, and forwards A2A HTTP traffic. The implementation is JavaScript; the four host plugins contain a generated copy of the same source. Hermes needs a small Python registration shim because its native plugin API is Python.

## Install and test

```bash
rtk npm ci
rtk npm test
```

The default suite needs only root dependencies and is suitable for Hermes/Connector installation checks. It includes the SDK-independent adapter protocol tests and package checks. DSH native driver tests have a separate, mandatory CI step:

```bash
rtk npm ci --prefix plugins/dsh
rtk npm run test:all
```

`test:dsh` runs only the native DSH suite and fails if its SDK dependencies are missing; tests are never silently skipped.

## Pair and run

DSH hosts can use the bundled native `dsh-a2a-connector/adapter`; see [installation and service setup](AGENT_INSTALL.md#dsh). The local Agent must expose `/.well-known/agent-card.json` and an A2A endpoint. Start the Connector with automatic pairing:

```bash
rtk node src/cli.js -auto-pair \
  -relay wss://dsh-relay.chuanbota.com/connect \
  -local http://127.0.0.1:9900
```

The CLI shows the approval page and confirmation code. An administrator checks the matching request at `https://dsh-relay.chuanbota.com/pair` and approves it. The Connector then registers and connects automatically. `-request-only` prints the pending request as JSON and exits; `-agent-id` optionally fixes the public Agent ID, otherwise one is generated from the local Agent Card name. A pending request survives Connector restarts until its ten-minute expiry.

The credential and pending request ID are stored in private `0600` files under the OS user config directory; use `-state` to choose another path. The default path matches the earlier Go CLI. Set `A2A_LOCAL_TOKEN` if the local Agent requires a Bearer token. `-allow-insecure` permits WS for local testing. The Connector pings every 25 seconds and reconnects with exponential backoff. Bodies are capped at 16 MiB and buffered; SSE streaming is not yet implemented.

## Host plugins

`plugins/openclaw`, `plugins/dsh`, and `plugins/workbuddy` are JavaScript integrations. `plugins/hermes` is a thin Python entry point that launches the same JavaScript client. Before installing or packing a plugin from this source tree, run:

```bash
rtk node scripts/sync-plugins.mjs
```

That command refreshes the checked-in copy of the canonical `src/` client in each plugin's `vendor/` directory. It also includes the `ws` dependency for Hermes, whose plugin installer does not install Node dependencies. OpenClaw, DSH, and WorkBuddy install `ws` from their package manifests. See [plugins/README.md](plugins/README.md) for package maintenance and [AGENT_INSTALL.md](AGENT_INSTALL.md) for host configuration.

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

For an agent-oriented installation and pairing procedure, see [AGENT_INSTALL.md](AGENT_INSTALL.md).

