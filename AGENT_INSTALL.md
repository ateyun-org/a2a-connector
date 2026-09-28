# A2A Connector 安装指南

按正在使用的宿主选择安装文档；[通用准备、配对与验证](docs/install/shared.md)说明所有宿主共用的前置条件、审批状态、故障恢复和连接检查。

本机 Agent 已提供 A2A HTTP origin 时，可先用 [安装脚本](scripts/install-connector.sh)完成预检、配对申请/复用、进程启动和状态诊断。WorkBuddy 模式会使用随包的 WorkBuddy CLI 与状态文件；其他宿主模式运行独立 Connector，宿主插件或 adapter 的首次配置仍见各自文档。

```bash
sh scripts/install-connector.sh install --host workbuddy --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900
sh scripts/install-connector.sh status --host workbuddy
```

同机多个 Agent 使用 `--instance` 隔离状态和进程，再用 `--expect-name` 验证 Agent Card。`--local auto --port-start 9900` 会寻找已启动的目标 A2A 服务；服务自身的监听端口须由宿主配置。DSH adapter 的端口冲突可由[DSH 安装文档](docs/install/dsh.md)中的自动递增配置处理。

- [OpenClaw](docs/install/openclaw.md)
- [Hermes](docs/install/hermes.md)
- [DSH](docs/install/dsh.md)（含常驻运行）
- [Tencent WorkBuddy](docs/install/workbuddy.md)

只安装一个宿主插件。审批时核对 Agent ID 和六位确认码；同一状态文件只允许一个 Connector 进程兑换一次性配对码。
