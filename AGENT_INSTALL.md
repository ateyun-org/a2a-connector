# A2A Connector 安装指南

A2A Connector 用于将宿主 Agent 接入 A2A Relay。它读取本机 Agent Card，完成配对并主动建立到 Relay 的 WSS 连接，再把 Relay 收到的 A2A 请求转发给本机 A2A HTTP 服务，让获得授权的其他 Agent 可以调用该 Agent。

Connector 需要一个实际可用的本机 A2A 服务。OpenClaw 和 Hermes 安装脚本会检测宿主能力：已有官方 A2A 时仅安装 Connector，缺少时才安装兼容服务；不要因为官方插件未启用或认证失败而另装服务。DSH 插件也提供宿主原生会话 adapter。其他宿主先查看对应文档，确认本机 A2A 服务配置。

按正在使用的宿主选择安装文档。所有宿主共用的前置条件、配对、故障恢复和连接检查见[通用准备、配对与验证](docs/install/shared.md)；安装命令和宿主配置见对应文档。

- [OpenClaw](docs/install/openclaw.md)
- [Hermes](docs/install/hermes.md)
- [DSH](docs/install/dsh.md)（含常驻运行）
- [Tencent WorkBuddy](docs/install/workbuddy.md)
