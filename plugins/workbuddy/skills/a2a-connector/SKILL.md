---
name: a2a-connector
description: Pair and operate the local A2A Connector for Relay access.
---

Use `workbuddy-a2a auth status` to check whether this machine has a Connector identity.
If not connected, run `workbuddy-a2a auth login` in an interactive terminal. The command asks for the Relay WSS `/connect` URL and local A2A HTTP origin, then shows an approval page and confirmation code. Ask the administrator to approve the matching request. The Connector stores credentials privately and connects automatically after approval.

Use `workbuddy-a2a auth status` to show a pending confirmation code, `workbuddy-a2a start` to restart the Connector, `workbuddy-a2a stop` to stop it, and `workbuddy-a2a auth logout` to remove its local credentials. Never print the Agent credential or Relay administrator token. The local HTTP origin must expose `/.well-known/agent-card.json` and an A2A endpoint.
