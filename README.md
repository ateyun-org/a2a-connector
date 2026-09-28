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

## Pair and run

If a local A2A origin is already running, `sh scripts/install-connector.sh install --host workbuddy --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900` automates preflight, local CLI dependency setup, pairing request reuse, and process launch. Use `status`, `stop`, or `repair` with the same `--host`; see [the WorkBuddy guide](docs/install/workbuddy.md#自动安装与诊断). For multiple agents, use a distinct `--instance` and `--expect-name`; `--local auto --port-start 9900` scans already running Agent Cards and selects the exact name. The Connector does not change an external agent's listening port. The bundled DSH adapter can increment a busy port and pass the actual port to the DSH Connector. For OpenClaw, Hermes, and DSH, the script can run an isolated standalone Connector after the host's A2A origin is configured; it does not install those host plugins or adapters.

DSH hosts can use the bundled native `dsh-a2a-connector/adapter`; see [DSH installation and service setup](docs/install/dsh.md). The local Agent must expose `/.well-known/agent-card.json` and an A2A endpoint. Start the Connector with automatic pairing:

```bash
node src/cli.js -auto-pair \
  -relay wss://dsh-relay.chuanbota.com/connect \
  -local http://127.0.0.1:9900
```

The CLI shows the approval page, Agent ID, and six-character confirmation code. An administrator checks **both** at `https://dsh-relay.chuanbota.com/pair` and approves the request. Approval creates a Relay record, which can remain offline while the Connector fetches a separate `pair_` code from `/pairing/status`, redeems it **once** at `/register`, saves the Agent credential, and opens the WSS tunnel. A pending request survives Connector restarts until its ten-minute expiry. Run only **one** Connector process for a given state path during pairing; two processes can race to redeem the same code.

CLI options (also supported by the copies in `plugins/*/vendor/connector/cli.js`):

| Option | Purpose |
| --- | --- |
| `-relay <wss://host/connect>` | Relay WSS URL; required for network operations. |
| `-local <http://127.0.0.1:port>` | Local A2A origin, without an endpoint path; required for discovery and forwarding. |
| `-auto-pair` | Reuse/create a pending request, wait for approval, redeem, save, then connect. |
| `-request-only` | Reuse/create a pending request, print public approval data as JSON, and exit without connecting. |
| `-enroll-only` | With `-pair-code` or `A2A_PAIR_CODE`, redeem exactly once, save the credential, and exit without connecting. |
| `-pair-code <pair_...>` | Single-use machine redemption code; avoid command history and prefer `A2A_PAIR_CODE` in a private process environment. This is **not** the six-character confirmation code. |
| `-state <private-file>` | Enrollment path; pending request uses the same path plus `.pending`. |
| `-agent-id <id>` | Optional fixed public ID for a new pairing; re-pairing an existing ID rotates its credential. |
| `-local-token <secret>` | Bearer token for the local origin; prefer `A2A_LOCAL_TOKEN` in the process environment. |
| `-token <secret>` | Existing Relay Connector credential; prefer the private state file or `A2A_CONNECTOR_TOKEN`. |
| `-allow-insecure` | Permit `ws://` **to the Relay** for local tests; local `http://` origins do not require it. |

For the manual flow, run `-request-only` first, wait for administrator approval, then have **one** process perform redemption. The automatic `-auto-pair` path handles that redemption without revealing the machine code. See [pairing recovery](docs/install/shared.md#兑换失败重复申请与安全恢复) before retrying a `401` or `409`.

The credential and pending request ID are stored in private `0600` files under the OS user config directory; use `-state` to choose another path. The default path matches the earlier Go CLI. Set `A2A_LOCAL_TOKEN` if the local Agent requires a Bearer token. The Connector pings every 25 seconds and reconnects with exponential backoff. Bodies are capped at 16 MiB and buffered; SSE streaming is not yet implemented.

## Host plugins

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
