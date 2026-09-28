# OpenClaw 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)，然后按以下步骤安装当前宿主。只运行此宿主对应的 Connector。

## 安装与配置

若 OpenClaw 已提供可访问的本机 A2A origin，且不需要宿主内的 `a2a_connector_pair` 工具，可改用[独立 Connector 安装脚本](../../scripts/install-connector.sh)：从仓库根目录执行 `sh scripts/install-connector.sh install --host openclaw --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900`。此路径不会安装下方的 OpenClaw 插件；不要同时运行两种路径连接同一个 Agent。

1. 在 Relay 所在的 Gateway 主机上操作。安装依赖并以链接方式安装本地插件：

   ```bash
   npm --prefix "/absolute/path/to/repository/a2a-connector/plugins/openclaw" ci
   openclaw plugins install --link "/absolute/path/to/repository/a2a-connector/plugins/openclaw"
   ```

   将示例路径替换为仓库所在主机上的实际绝对路径。

   本地插件安装和配置细节见 [OpenClaw 插件安装文档](https://docs.openclaw.ai/cli/plugins/install)。

2. 在现有 OpenClaw 配置中合并以下条目，不要覆盖其他配置：

   ```json5
   {
     plugins: {
       entries: {
         "a2a-connector": {
           enabled: true,
           config: {
             relay: "wss://dsh-relay.chuanbota.com/connect",
             local: "http://127.0.0.1:9900",
             // 仅在本机 Agent 需要认证时配置：
             // localTokenEnv: "MY_LOCAL_AGENT_TOKEN",
             // 可选稳定 ID：
             // agentId: "my-agent"
             // 同机多个 Agent 时，每个实例须使用不同的绝对状态路径：
             // state: "/absolute/path/to/private/openclaw-reviewer.json"
           },
         },
       },
     },
   }
   ```

3. 启用插件并验证 Gateway 中的运行态：

   ```bash
   openclaw plugins enable a2a-connector
   openclaw plugins inspect a2a-connector --runtime --json
   ```

   成功的插件安装/启用会通过本地 Gateway 应用；默认配置支持热加载，不要求固定执行重启。`inspect --runtime` 在检查 CLI 进程中载入插件，不单独证明正在服务的 Gateway 已加载。进入目标 Agent 实际调用 `a2a_connector_pair`；如果 Gateway 未注册该工具，执行 `openclaw plugins reload a2a-connector` 后再检查。Gateway 停止时，启动它后插件才会加载。见 [OpenClaw 插件生效与验证文档](https://docs.openclaw.ai/plugins)。

完成安装后，按[通用配对与验证](shared.md#配对与授权边界)检查审批、凭据和连线。
