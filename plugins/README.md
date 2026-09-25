# Connector host packages

Installation, configuration, pairing and troubleshooting are maintained in [AGENT_INSTALL.md](../AGENT_INSTALL.md). This page covers package structure for maintainers.

| Package | Integration |
| --- | --- |
| `openclaw` | JavaScript plugin; host installs `ws` and `typebox`. |
| `hermes` | Python hook/tool shim launching Node 22+; `ws` is vendored. |
| `dsh` | Cordis Connector plugin; `dsh-a2a-connector/adapter` exposes a native DSH session endpoint. DSH SDKs stay in peer dependencies to share host instances. |
| `workbuddy` | CLI, skill and Node 22 runtime declaration; host installs `ws`. |

After changing the canonical Connector `src/`, run `rtk node scripts/sync-plugins.mjs` from the repository root. All four packages carry generated Connector sources in `vendor/connector/`. Do not edit those copies directly. The native DSH adapter is package-specific and is not copied to other hosts. To bump versions across the root package and all host plugins, run `./bump-version.sh <version|patch|minor|major>`.

Run `rtk npm ci` and `rtk npm test` for SDK-independent Connector/package tests (including Hermes installation checks). For DSH native driver validation, also run `rtk npm ci --prefix plugins/dsh` and `rtk npm run test:dsh`, or use `rtk npm run test:all` for both suites. CI first runs the default suite without DSH dependencies, then installs DSH development dependencies and runs the native suite. It also checks source-copy parity and the DSH peer dependency contract. WorkBuddy marketplace distribution still requires host review.

Hermes shim checks: `rtk python3 -m unittest discover -s test -p 'test_hermes.py'`. These require only the Python standard library and run in CI. They cover registration diagnostics, unpaired startup, private stderr/PID files, early child failure, and cleanup after PID-write failure.
