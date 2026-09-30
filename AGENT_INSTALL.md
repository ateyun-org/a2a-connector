# A2A Connector 安装指南

A2A Connector 用于将宿主 Agent 接入 A2A Relay。它读取本机 Agent Card，完成配对并主动建立到 Relay 的 WSS 连接，再把 Relay 收到的 A2A 请求转发给本机 A2A HTTP 服务，让获得授权的其他 Agent 可以调用该 Agent。

Connector 需要一个实际可用的本机 A2A 服务。OpenClaw 和 Hermes 安装脚本会检测宿主能力：已有官方 A2A 时仅安装 Connector，缺少时才安装兼容服务；不要因为官方插件未启用或认证失败而另装服务。DSH 插件也提供宿主原生会话 adapter。其他宿主先查看对应文档，确认本机 A2A 服务配置。

Hermes 安装先执行 `install-hermes.py --check`，验证实际 Python/Node 路径并检查模块能力；安装阶段不要求官方服务已经启动。安装和配置完成后，从 Gateway 外部一次性加载插件/platform，再用 `doctor`、`pair`、`status` 验证。批准后由同一个 worker 自动兑换，避免审批期间重启 Gateway。Windows 0.2.4 的旧进程清理和升级注意事项见 Hermes 文档。

按正在使用的宿主选择安装文档。所有宿主共用的前置条件、配对、故障恢复和连接检查见[通用准备、配对与验证](docs/install/shared.md)；安装命令和宿主配置见对应文档。

- [OpenClaw](docs/install/openclaw.md)
- [Hermes](docs/install/hermes.md)
- [DSH](docs/install/dsh.md)（含常驻运行）
- [Tencent WorkBuddy](docs/install/workbuddy.md)
