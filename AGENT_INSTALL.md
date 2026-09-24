# A2A Connector Agent 安装流程

这份流程供负责配置本机 Agent 的 AI Agent 执行。先确认运行环境和参数，再安装对应宿主插件、完成配对并检查连接。

## 需要确认的参数

开始前从现有配置或用户处确认：

- **Relay URL**：完整的 WSS 连接地址，例如 `wss://relay.example.com/connect`。
- **本机 A2A origin**：Agent Card 和 A2A HTTP 服务所在的 origin，例如 `http://127.0.0.1:9900`。不要附加路径、查询参数或尾部端点路径。
- **宿主类型**：OpenClaw、Hermes、DSH 或 WorkBuddy。先用已安装的宿主，不要同时安装多个插件。
- **本机认证**：若本机 Agent Card/A2A 接口要求 Bearer token，确认 token 已存在于宿主进程环境的哪个变量中；不要把 token 写入命令历史、配置明文或对话。
- **Agent ID**：通常留空，让 Connector 从 Agent Card 名称生成。如果用户给了稳定 ID，再配置 `agentId`。
- **DSH profile**：宿主是 DSH 时，确认目标 profile 名称；不要默认安装到别的 profile。

不要猜 Relay 地址或本机端口。缺少必需参数时，只向用户询问缺少的值，先不要申请配对。

## 安装前检查

1. 确认目标 Agent 已启动，并从 Connector 所在机器访问本机 origin 下的 `/.well-known/agent-card.json`。HTTP 状态应为 200，响应 JSON 应包含非空 `name`。
2. 确认本机 Agent Card 中的 A2A 接口地址确实可由 Relay 所在的 Connector 进程访问。若 Agent 还没有本机 A2A HTTP endpoint，先停止；需要先安装或配置 A2A adapter。
3. 确认 Relay URL 使用 `wss://` 且路径为 `/connect`。生产环境不要启用 `allowInsecure`。
4. 优先复用已安装的 Connector 插件和现有配对身份。不要为了重试而重复配对；批准已有 Agent ID 会轮换该 Agent 的凭据。
5. 只安装与当前宿主对应的插件目录。插件包含 `vendor/connector`，不要删掉或只拷贝入口文件。
6. OpenClaw、Hermes 和 DSH 使用 Node.js 运行 Connector；确认宿主进程使用 Node.js 22 或更新版本。WorkBuddy 插件声明了 Node.js 22 runtime。

## 按宿主安装

### OpenClaw

1. 在 Relay 所在的 Gateway 主机上操作。安装依赖并以链接方式安装本地插件：

   ```bash
   rtk npm --prefix "/absolute/path/to/repository/a2a-connector/plugins/openclaw" ci
   rtk openclaw plugins install --link "/absolute/path/to/repository/a2a-connector/plugins/openclaw"
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
             relay: "wss://relay.example.com/connect",
             local: "http://127.0.0.1:9900",
             // 仅在本机 Agent 需要认证时配置：
             // localTokenEnv: "MY_LOCAL_AGENT_TOKEN",
             // 可选稳定 ID：
             // agentId: "my-agent"
           }
         }
       }
     }
   }
   ```

3. 启用插件并按宿主要求 reload/restart Gateway：

   ```bash
   rtk openclaw plugins enable a2a-connector
   rtk openclaw plugins inspect a2a-connector --runtime --json
   ```

   运行态信息应包含工具 `a2a_connector_pair`。Gateway 启动后 Connector 会自动创建或继续等待配对。

### Hermes

1. 确认 Hermes 进程可用 Node.js 22 或更新版本。安装完整插件目录：

   ```bash
   rtk mkdir -p "$HOME/.hermes/plugins/a2a-connector"
   rtk cp -R "/absolute/path/to/repository/a2a-connector/plugins/hermes/." "$HOME/.hermes/plugins/a2a-connector/"
   ```

   将示例路径替换为仓库所在主机上的实际绝对路径。

2. 在启动 Hermes 的服务环境中设置：

   ```text
   A2A_RELAY_URL=wss://relay.example.com/connect
   A2A_LOCAL_URL=http://127.0.0.1:9900
   ```

   可选变量：`A2A_AGENT_ID`、`A2A_NODE_BINARY`、`A2A_CONNECTOR_STATE`、`A2A_LOCAL_TOKEN`、`A2A_ALLOW_INSECURE`。不要将凭据写入共享 shell profile；使用该 Hermes 服务专属的环境配置。`A2A_ALLOW_INSECURE=1` 仅用于本地测试。

3. 重新加载 Hermes 插件或重启 Hermes。插件注册 `a2a_connector_pair` 工具和 `/a2a_connector pair|start|stop` 命令。

### DSH

1. 在目标 DSH Agent 主机安装 `plugins/dsh`，作为独立插件与 `dsh-a2a` 一起使用。不要把该插件装到中央 `dsh-a2a` Orchestrator 上。
2. 如果从源码目录安装，先在 `a2a-connector/plugins/dsh/` 安装依赖，再通过 DSH CLI 注册整个插件目录：

   ```bash
   rtk npm --prefix "/absolute/path/to/repository/a2a-connector/plugins/dsh" ci
   rtk dsh plugin --profile "web" add "file:/absolute/path/to/repository/a2a-connector/plugins/dsh"
   ```

   替换示例仓库路径和 `web` profile 为目标主机上的实际值。在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 合并以下 Cordis 条目，不要覆盖其他插件：

   ```yaml
   - insert:
       - id: a2a-connector
         name: a2a-connector
         config:
           relay: wss://relay.example.com/connect
           local: http://127.0.0.1:9900
           # 本机 Agent 要求认证时可设置：
           # localTokenEnv: MY_LOCAL_AGENT_TOKEN
           # 可选稳定 ID：
           # agentId: my-agent
   ```

   配置键还支持 `binary`、`state`、`allowInsecure`。保持 `allowInsecure` 为 `false`。
4. 按该 DSH 实例的插件管理方式 reload/restart；确认插件加载且 `a2a_connector_pair` 工具可调用。

### Tencent WorkBuddy

1. 使用 WorkBuddy 的插件/连接器安装入口安装完整的 `plugins/workbuddy` 目录。它自带 CLI、skill 和 Node 22 runtime 声明。
2. 在 WorkBuddy 终端执行：

   ```bash
   rtk workbuddy-a2a auth login
   ```

   按提示输入 Relay WSS `/connect` URL 和本机 A2A origin。命令会生成配对请求并启动 Connector。
3. 用 `rtk workbuddy-a2a auth status` 查看配对状态；管理生命周期可用 `rtk workbuddy-a2a start` 和 `rtk workbuddy-a2a stop`。

## 配对与授权边界

1. Connector 首次启动后，会显示 Relay `/pair` 审批页、Agent ID 和六位确认码。Agent 可调用 `a2a_connector_pair` 或对应宿主命令查看待审批信息。
2. 将审批 URL、Agent ID 和确认码交给用户/Relay 管理员。**不要索取或输入 Relay 管理员 token，也不要代替管理员批准配对。** 管理员应在 Relay 页面核对 Agent ID 和确认码后批准。
3. 获批后 Connector 会自行注册、保存 Agent 专属凭据并连接。凭据默认保存在用户配置目录下的 `a2a-connector` 私有状态文件中，权限为 `0600`；不要读取、打印、复制或提交该文件。
4. 管理员确认码不是 Connector 凭据。等待审批期间不要创建第二个请求；待请求会持久化并在十分钟后过期。

## 完成检查

- Agent Card URL 返回 200 且包含 Agent 名称。
- 宿主已加载插件，`a2a_connector_pair` 工具已注册。
- 未配对时报告待审批链接、Agent ID 和确认码；已配对时只报告 Agent ID/连接状态，不展示 token。
- 管理员批准后，重新检查宿主的配对状态并确认 Connector 子进程仍在运行。直接 CLI 模式会输出 `Agent paired`；宿主插件模式以插件状态或 `a2a_connector_pair` 的已配对结果为准。连接故障先检查本机 Agent、Relay WSS 和本机 token 环境变量；不要直接删除状态文件或重新配对。
