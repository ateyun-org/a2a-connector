# Connector host packages

Installation, configuration, pairing and troubleshooting are maintained in [AGENT_INSTALL.md](../AGENT_INSTALL.md). This page covers package structure for maintainers.

| Package | Integration |
| --- | --- |
| `openclaw` | JavaScript plugin; host installs `ws` and `typebox`. |
| `hermes` | Python hook/tool shim launching Node 22+; `ws` is vendored. |
| `dsh` | Cordis Connector plugin; `dsh-a2a-connector/adapter` exposes a native DSH session endpoint. DSH SDKs stay in peer dependencies to share host instances. |
| `workbuddy` | CLI, skill and Node 22 runtime declaration; host installs `ws`. |

After changing the canonical Connector `src/`, run `rtk node scripts/sync-plugins.mjs` from the repository root. All four packages carry generated Connector sources in `vendor/connector/`. Do not edit those copies directly. The native DSH adapter is package-specific and is not copied to other hosts.

Run `rtk npm ci`, `rtk npm ci --prefix plugins/dsh`, then `rtk npm test`. CI checks source-copy parity and the DSH peer dependency contract. WorkBuddy marketplace distribution still requires host review.
