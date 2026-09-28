# Connector host packages

Choose a host from the [installation index](../AGENT_INSTALL.md). Shared pairing and troubleshooting steps are in [the common guide](../docs/install/shared.md). This page covers package structure for maintainers.

| Package     | Integration                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw`  | JavaScript plugin; host installs `ws` and `typebox`.                                                                                                    |
| `hermes`    | Python hook/tool shim launching Node 22+; `ws` is vendored.                                                                                             |
| `dsh`       | Cordis Connector plugin; `dsh-a2a-connector/adapter` exposes a native DSH session endpoint. DSH SDKs stay in peer dependencies to share host instances. |
| `workbuddy` | CLI, skill and Node 22 runtime declaration; the verified local CLI path installs `ws` with `npm ci --prefix plugins/workbuddy`.                          |

After changing the canonical Connector `src/`, run `node scripts/sync-plugins.mjs` from the repository root. All four packages carry generated Connector sources in `vendor/connector/`. Do not edit those copies directly. The native DSH adapter is package-specific and is not copied to other hosts. To bump versions across the root package and all host plugins, run `./bump-version.sh <version|patch|minor|major>`.

Run `npm ci` and `npm test` for SDK-independent Connector/package tests (including Hermes installation checks). For DSH native driver validation, also run `npm ci --prefix plugins/dsh` and `npm run test:dsh`, or use `npm run test:all` for both suites. CI first runs the default suite without DSH dependencies, then installs DSH development dependencies and runs the native suite. It also checks source-copy parity and the DSH peer dependency contract.

WorkBuddy marketplace distribution still requires host review. The current package has a root-level `cli.json` and `connector-meta.json`; it has no `.codebuddy-plugin/plugin.json`. An inspected WorkBuddy marketplace sample places `cli.json` under `ai.workbuddy/` and provides the plugin manifest. Do not claim this package is discoverable in the GUI or that `connector-meta.json` enforces `minWorkbuddyVersion` until the target WorkBuddy version and packaging route have been tested. The documented local CLI route is in the [WorkBuddy installation guide](../docs/install/workbuddy.md); it connects the local origin to the Relay without installing a GUI connector or skill into WorkBuddy.

Hermes shim checks: `python3 -m unittest discover -s test -p 'test_hermes.py'`. These require only the Python standard library and run in CI. They cover registration diagnostics, unpaired startup, private stderr/PID files, early child failure, and cleanup after PID-write failure.
