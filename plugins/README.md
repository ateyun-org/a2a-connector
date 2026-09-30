# Connector host packages

Choose a host from the [installation index](../AGENT_INSTALL.md). Shared pairing and troubleshooting steps are in [the common guide](../docs/install/shared.md). This page covers package structure for maintainers.

| Package     | Integration                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw`  | JavaScript plugin with `ws`; detects native A2A, and installs/loads CLI-backed compatibility A2A only when absent. No newer plugin SDK import or bundled OpenClaw is required. |
| `hermes`    | Python hook/tool shim launching Node 22+; detects native A2A and provisions quiet-CLI compatibility only when absent. `ws` is vendored. |
| `dsh`       | One Cordis plugin starts the native DSH A2A service and Relay Connector together; configured `agents` add outbound A2A delegation. DSH SDKs stay in peer dependencies to share host instances. |
| `workbuddy` | CLI, skill and Node 22 runtime declaration; the verified local CLI path installs `ws` with `npm ci --prefix plugins/workbuddy`.                          |

After changing the canonical Connector `src/`, run `node scripts/sync-plugins.mjs` from the repository root. All four packages carry generated Connector sources in `vendor/connector/`. Do not edit those copies directly. The native DSH adapter is package-specific and is not copied to other hosts. To bump versions across the root package and all host plugins, run `./bump-version.sh <version|patch|minor|major>`.

Run `npm ci` and `npm test` for SDK-independent Connector/package tests (including Hermes installation checks). For DSH native driver validation, also run `npm ci --prefix plugins/dsh` and `npm run test:dsh`, or use `npm run test:all` for both suites. CI first runs the default suite without DSH dependencies, then installs DSH development dependencies and runs the native suite. It also checks source-copy parity and the DSH peer dependency contract.

WorkBuddy marketplace distribution still requires host review. The [current public CLI + Skill connector guide](https://open.workbuddy.cn/docs/connector) describes a submission package with root-level `connector-meta.json`, `cli.json`, `icon.svg`, and `skills/`. An inspected marketplace download used an `ai.workbuddy/` directory and an internal manifest; these may be different packaging stages. Test the actual upload, client discovery, and version gate before claiming GUI support. The documented local CLI route is in the [WorkBuddy installation guide](../docs/install/workbuddy.md); it connects an existing local origin to the Relay without installing a GUI connector or skill into WorkBuddy.

Hermes checks: `python3 -m unittest discover -s test -p 'test_hermes*.py'`. These require only the Python standard library and run in CI. They cover registration diagnostics, unpaired startup, private stderr/PID files, early child failure, cleanup after PID-write failure, native capability detection, task authentication and conditional installation. The default Node suite also tests the compatibility adapter, CLI session continuation, and actual Connector tunnel frames.
