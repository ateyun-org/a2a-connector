---
name: a2a-connector
description: Pair and operate the local A2A Connector for Relay access.
---

Use `workbuddy-a2a auth status` to check whether this machine has a Connector identity.
If not connected, tell the user to obtain a one-time `pair_` code from the Relay administrator, then run `workbuddy-a2a auth login` in an interactive terminal. The command asks for the Relay WSS `/connect` URL, local A2A HTTP origin, and code; it stores credentials under the user's private config directory and starts the Connector.

Use `workbuddy-a2a start` to restart the Connector, `workbuddy-a2a stop` to stop it, and `workbuddy-a2a auth logout` to remove its local credentials. Do not put pairing codes or credentials in chat output or logs. The local HTTP origin must expose `/.well-known/agent-card.json` and an A2A endpoint.
