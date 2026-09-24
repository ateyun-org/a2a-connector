# a2a-connector

Node.js 22+ outbound A2A tunnel client. The Connector discovers a local Agent Card, connects to the GoFrame Relay over WSS, and forwards A2A HTTP traffic. The implementation is JavaScript; the four host plugins contain a generated copy of the same source. Hermes needs a small Python registration shim because its native plugin API is Python.

## Install and test

```bash
rtk npm ci
rtk npm test
```

## Pair and run

The local Agent must expose `/.well-known/agent-card.json` and an A2A endpoint. Ask the Relay administrator for a single-use `pair_` code. Then:

```bash
export A2A_PAIR_CODE=YOUR_PAIR_CODE
rtk node src/cli.js -enroll-only \
  -relay wss://dsh-relay.chuanbota.com/connect \
  -local http://127.0.0.1:9900
unset A2A_PAIR_CODE
rtk node src/cli.js \
  -relay wss://dsh-relay.chuanbota.com/connect \
  -local http://127.0.0.1:9900
```

The token is stored in a private `0600` file under the OS user config directory; use `-state` to choose another path. The default path matches the earlier Go CLI. Set `A2A_LOCAL_TOKEN` if the local Agent requires a Bearer token. `-allow-insecure` permits WS for local testing. The Connector pings every 25 seconds and reconnects with exponential backoff. Bodies are capped at 16 MiB and buffered; SSE streaming is not yet implemented.

## Host plugins

`plugins/openclaw`, `plugins/dsh`, and `plugins/workbuddy` are JavaScript integrations. `plugins/hermes` is a thin Python entry point that launches the same JavaScript client. Before installing or packing a plugin from this source tree, run:

```bash
rtk node scripts/sync-plugins.mjs
```

That command refreshes the checked-in copy of the canonical `src/` client in each plugin's `vendor/` directory. It also includes the `ws` dependency for Hermes, whose plugin installer does not install Node dependencies. OpenClaw, DSH, and WorkBuddy install `ws` from their package manifests. See [plugins/README.md](plugins/README.md) for host configuration.
