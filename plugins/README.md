# Connector host packages

Choose a host from the [installation index](../AGENT_INSTALL.md). Shared pairing and troubleshooting steps are in [the common guide](../docs/install/shared.md). This page covers package structure for maintainers.

| Package     | Integration                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw`  | JavaScript plugin with `ws`; detects native A2A, and installs/loads CLI-backed compatibility A2A only when absent. No newer plugin SDK import or bundled OpenClaw is required. |
| `hermes`    | Python hook/tool shim launching Node 22+; detects native A2A and provisions quiet-CLI compatibility only when absent. `ws` is vendored. |
| `dsh`       | One Cordis plugin starts the native DSH A2A service and Relay Connector together; configured `agents` add outbound A2A delegation. DSH SDKs stay in peer dependencies to share host instances. |
| `workbuddy` | CLI + Skill with Node 22; starts an authenticated desktop or cloud ACP adapter and Connector together, with durable incoming/outgoing tracking. |
| `workbuddy-mcp` | Remote OAuth MCP + Skill for Buddy application binding; calls authorized Relay targets without a local CLI installation. |

After changing the canonical Connector `src/`, run `node scripts/sync-plugins.mjs` from the repository root. All four packages carry generated Connector sources in `vendor/connector/`. Do not edit those copies directly. The native DSH adapter is package-specific and is not copied to other hosts. To bump versions across the root package and all host plugins, run `./bump-version.sh <version|patch|minor|major>`.

Run `npm ci` and `npm test` for SDK-independent Connector/package tests (including Hermes installation checks). For DSH native driver validation, also run `npm ci --prefix plugins/dsh` and `npm run test:dsh`, or use `npm run test:all` for both suites. CI first runs the default suite without DSH dependencies, then installs DSH development dependencies and runs the native suite. It also checks source-copy parity and the DSH peer dependency contract.

WorkBuddy distribution still requires host review. `python3 scripts/package-workbuddy.py` builds the root-level layout from the [public CLI + Skill guide](https://open.workbuddy.cn/docs/connector), including actual runtime code. GUI auth uses noninteractive `auth connect`, and `auth status` is read-only. Both receiving modes need separate WorkBuddy OAuth authorization with their respective desktop/cloud scopes. Actual upload, client discovery and real-account execution must still be verified in the target client. The [WorkBuddy guide](../docs/install/workbuddy.md) distinguishes built-in setup from the legacy external origin.

Hermes checks: `python3 -m unittest discover -s test -p 'test_hermes*.py'`. They use only the standard library and run on Ubuntu and native Windows/Python 3.11 in CI, including Windows DACL checks. The Node suite covers compatibility sessions, actual tunnel frames, expired-request renewal, approval/redemption, reuse of manual runners, live health and managed IPC shutdown. Installation checks capability without a running platform; runtime authentication remains mandatory. Never use Python `os.kill(pid, 0)` as a Windows liveness probe.
