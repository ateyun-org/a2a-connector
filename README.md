# a2a-connector

Outbound reverse tunnel client for an A2A Agent running on the same machine or private network. It discovers the local Agent Card, opens a WebSocket to `a2a-relay`, and forwards HTTP requests to the local Agent.

## Build and test

From this directory:

```bash
rtk go test ./...
rtk go build -o a2a-connector ./cmd/connector
```

## Run

The local Agent must expose `/.well-known/agent-card.json` and its A2A endpoint. Obtain the per-Agent token whose SHA-256 digest is registered on the Relay.

```bash
export A2A_CONNECTOR_TOKEN=YOUR_CONNECTOR_TOKEN
rtk go run ./cmd/connector \
  -relay wss://relay.example.com/connect \
  -local http://127.0.0.1:9900
```

Set `A2A_LOCAL_TOKEN` if the local Agent itself requires a Bearer token. Use `-allow-insecure` only for local WS tests. The Connector pings every 25 seconds and reconnects with exponential backoff up to 30 seconds. HTTP bodies are capped at 16 MiB and buffered; SSE streaming is not yet supported.
