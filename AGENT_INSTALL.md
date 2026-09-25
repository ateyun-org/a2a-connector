# A2A Connector Agent 安装流程

这份流程供负责配置本机 Agent 的 AI Agent 执行。先确认运行环境和参数，再安装对应宿主插件、完成配对并检查连接。

## 需要确认的参数

开始前从现有配置或用户处确认：

- **Relay URL**：`wss://dsh-relay.chuanbota.com/connect`。配对审批页是 `https://dsh-relay.chuanbota.com/pair`。
- **本机 A2A origin**：Agent Card 和 A2A HTTP 服务所在的 origin，例如 `http://127.0.0.1:9900`。不要附加路径、查询参数或尾部端点路径。
- **宿主类型**：OpenClaw、Hermes、DSH 或 WorkBuddy。先用已安装的宿主，不要同时安装多个插件。
- **本机认证**：若本机 Agent Card/A2A 接口要求 Bearer token，确认 token 已存在于宿主进程环境的哪个变量中；不要把 token 写入命令历史、配置明文或对话。
- **Agent ID**：通常留空。Connector 首次配对时会根据 Agent Card 名称生成 ID，并保存在状态文件里；单纯重启不需要固定 ID。只有在状态文件会重建、部署系统要预先引用固定 ID，或有明确的身份迁移需求时才配置。OpenClaw/DSH 使用 `agentId`，Hermes 使用 `A2A_AGENT_ID`，独立 CLI 使用 `-agent-id`；WorkBuddy 当前没有 ID 覆盖项。复用已有 ID 重新配对会轮换它的凭据。
- **DSH profile**：宿主是 DSH 时，确认目标 profile 名称；不要默认安装到别的 profile。

不要猜 Relay 地址或本机端口。缺少必需参数时，只向用户询问缺少的值，先不要申请配对。

## 安装前检查

1. 确认目标 Agent 已启动，并从 Connector 所在机器访问本机 origin 下的 `/.well-known/agent-card.json`。HTTP 状态应为 200，响应 JSON 应包含非空 `name`。
2. 确认本机 Agent Card 中的 A2A 接口地址确实可由 Relay 所在的 Connector 进程访问。若 Agent 还没有本机 A2A HTTP endpoint，先安装或配置 A2A adapter。DSH 使用下方随包提供的 `dsh-a2a-connector/adapter`；其他宿主需使用其自身的 A2A adapter。完成后重新执行这项检查，再配对。
3. 确认 Relay URL 使用 `wss://` 且路径为 `/connect`。生产环境不要启用 `allowInsecure`。
4. 优先复用已安装的 Connector 插件和现有配对身份。不要为了重试而重复配对；批准已有 Agent ID 会轮换该 Agent 的凭据。升级 Hermes 插件时，`plugins/` 下只能保留一个声明 `name: a2a-connector` 的目录；把旧目录移到 `plugins/` 外备份，单纯改名仍可能被扫描并注册同名 Hook。
5. 只安装与当前宿主对应的插件目录。`vendor/connector` 是随插件分发的 Connector 客户端副本，不要删掉或只拷贝入口文件。依赖安装方式因宿主不同，见下表。
6. OpenClaw、Hermes 和 DSH 使用 Node.js 运行 Connector；确认宿主进程使用 Node.js 22 或更新版本。WorkBuddy 插件声明了 Node.js 22 runtime。

| 宿主      | Connector 依赖                                                | 安装时如何处理                                                                                                                        |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw  | `typebox`、`ws`                                               | 从源码目录安装时执行 `npm ci`。                                                                                                       |
| DSH       | DSH SDK、`ws`                                                 | 用 `dsh plugin --profile <profile> add file:<path>` 安装到目标 profile；该命令会按 package manifest 安装依赖，不必另外运行 `npm ci`。 |
| Hermes    | `ws` 已包含在 `plugins/hermes/vendor/connector/node_modules/` | 不要对 Hermes 目录执行 `npm ci`；确认 Node.js 22+ 可用即可。                                                                          |
| WorkBuddy | `ws` 由 package manifest 声明，Node.js 22 runtime 由宿主提供  | 使用 WorkBuddy 插件安装入口处理依赖。                                                                                                 |

## 按宿主安装

### OpenClaw

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

### Hermes

从仓库源码安装前，如需测试，在仓库根目录执行 `npm ci` 和 `npm test`。默认测试不需要 DSH SDK；Hermes 插件目录本身仍无需 npm 安装。`npm run test:dsh` / `test:all` 是维护者验证 DSH 原生 adapter 的入口，需先安装 `plugins/dsh` 开发依赖。若旧版本默认测试报缺少 `@deepseek-ai/schemastery`，更新到拆分测试后的版本再验证；不要将失败当作已通过，也无需为 Hermes 安装 DSH SDK。同步脚本只更新 vendor 文件，不能修复测试依赖问题。

1. 确认 Hermes 进程可用 Node.js 22 或更新版本。升级已有安装时，先在旧插件仍可用的目标 Agent 中执行 `/a2a_connector stop`；Connector 是独立启动的子进程，Gateway 重启不保证它退出。随后将旧插件目录备份到 `plugins/` 外，再安装完整插件目录：

   ```bash
   hermes_root="${HERMES_HOME:-$HOME/.hermes}"
   mkdir -p "$hermes_root/plugins"
   if [ -e "$hermes_root/plugins/a2a-connector" ]; then
     mv "$hermes_root/plugins/a2a-connector" "$hermes_root/a2a-connector.backup-$(date +%Y%m%d-%H%M%S)"
   fi
   mkdir -p "$hermes_root/plugins/a2a-connector"
   cp -R "/absolute/path/to/repository/a2a-connector/plugins/hermes/." "$hermes_root/plugins/a2a-connector/"
   ```

   将示例仓库路径替换为仓库所在主机上的实际绝对路径；若启用了 `HERMES_HOME`，上面的命令会把插件安装到该 home。检查 `plugins/` 下其他备份目录的 `plugin.yaml`；凡是也声明 `name: a2a-connector` 的，都移到 `plugins/` 外。Hermes 随包已包含 `ws`，无需再执行 `npm install ws`；不要删除原有 Connector 状态文件。若旧插件已不可用，先按下文核对 PID 与命令行，只终止确认属于旧 Connector 的进程，再处理对应 PID 文件。

2. 这是 Hermes 的普通工具/Hook 插件，不是 Gateway platform 插件。先查看现有插件，再在目标 Hermes profile 中启用；不要把它配置到 `platforms.*.enabled`：

   ```bash
   hermes plugins list
   hermes plugins enable a2a-connector
   ```

   上述命令操作默认 profile。目标是命名的独立 profile 时，给两个命令都加同一个 `-p`，例如 `hermes -p "coder" plugins list` 和 `hermes -p "coder" plugins enable a2a-connector`。multiplex Gateway 只启用启动该共享 Gateway 的 profile。Hermes 的通用用户插件默认需要加入 `plugins.enabled`；`hermes plugins enable` 会更新该配置。见 [Hermes 插件文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md)。

3. 在该 Hermes 实例读取的环境文件中配置：默认安装使用 `~/.hermes/.env`；若设置了 `HERMES_HOME`，使用对应 home 下的 `.env`。独立命名 profile 使用它自己的 `~/.hermes/profiles/<profile>/.env`。保留原文件内容并将权限设为 `0600`。多 profile multiplex Gateway 是一个共享进程，而 Connector 直接读取进程环境；此时把 Connector 参数放入启动该 Gateway 的 home 环境中，不要假设它会按每个 profile 单独启动。`.env` 由宿主加载时，`/proc/<Gateway PID>/environ` 不一定反映加载后的 Python 进程环境，也不会自动给当前交互 shell 导出这些变量。

   ```text
   A2A_RELAY_URL=wss://dsh-relay.chuanbota.com/connect
   A2A_LOCAL_URL=http://127.0.0.1:9900
   # 如果本机 Agent 要求 Bearer token，填入 token 值，不是变量名：
   A2A_LOCAL_TOKEN=replace-with-local-agent-token
   # 服务 PATH 找不到 node 时，填写 Node.js 22+ 的绝对路径：
   A2A_NODE_BINARY=/absolute/path/to/node
   # 多个 Connector 实例时，为每个实例指定不同状态文件：
   A2A_CONNECTOR_STATE=/absolute/path/to/private/hermes-connector.json
   ```

   `A2A_LOCAL_TOKEN` 的值会作为 Bearer token 发送到本机 Agent Card 和 A2A endpoint。OpenClaw/DSH 的 `localTokenEnv` 则填写**已有环境变量的名字**；插件会从该变量取值，例如 `localTokenEnv: "MY_LOCAL_AGENT_TOKEN"`。不要把真实 token 写进命令参数、配置示例或对话。

   其他可选变量：`A2A_AGENT_ID`、`A2A_ALLOW_INSECURE=1`。生产环境不要设置 `A2A_ALLOW_INSECURE`；固定 Agent ID 的使用场景见上面的参数说明。

   `A2A_NODE_BINARY` 默认是 `node`，要求 Connector 子进程的 PATH 能找到 Node.js。交互终端中的 `node --version` 成功不代表 systemd/launchd 服务也能找到它；给服务设置绝对路径更可靠。

   插件注册时会执行一次不发网络请求的自检：缺少必需环境变量、Node 路径或随包 CLI 时记 ERROR；未配对或等待审批会单独提示，但不阻止 session start hook 自动申请/恢复配对。`A2A_LOCAL_TOKEN` 仅在本机接口启用认证时需要，缺失不属于自检错误。

   启动失败在 Gateway 日志中以 ERROR 报告。子进程 stderr 保存在状态文件旁的 `hermes.stderr.log`（自定义 state 时替换其扩展名），权限 `0600`，重启追加写入；排查时检查该文件，不要把原始日志直接贴到对话中。日志不会自动轮转，需按主机日志保留策略管理。启动后立即退出会报退出码及日志路径；稍后发生的错误也会保留在该文件。命令报告“进程启动”不代表已配对或网络连通，仍需按下方步骤验证。

   Hermes Connector 的状态文件默认是 `~/.config/a2a-connector/hermes.json`，待审批请求写入该路径加 `.pending`，PID 文件是 `~/.config/a2a-connector/hermes.pid`。多个独立 Hermes/Connector 实例应设置不同的 `A2A_CONNECTOR_STATE`，避免共用身份文件。`A2A_ALLOW_INSECURE=1` 仅用于本地测试。

4. 让配置生效：

   ```bash
   hermes gateway restart
   hermes gateway status
   ```

   目标是命名的独立 profile 时，两个命令都使用同一个 profile，例如 `hermes -p "coder" gateway restart` 和 `hermes -p "coder" gateway status`。若该 profile 由 multiplex Gateway 服务，只重启共享的默认 Gateway：`hermes gateway restart`。Hermes Gateway 在进程启动时加载插件和环境；只运行 `hermes plugins enable` 不会让已经运行的 Gateway 立即加载它。普通 `.env` 内容变更后重启即可，不需要 `daemon-reload`。

   不要直接编辑 Hermes 生成的 systemd unit 中的 `Environment=` 行；Gateway 管理命令可能重新生成 unit 并覆盖该改动。默认优先用上述 `.env`。Linux systemd 用户服务如需独立环境文件，将变量放入 `~/.hermes/a2a-connector.env` 并设为 `0600`，然后给服务加 drop-in：

   ```bash
   systemctl --user edit hermes-gateway.service
   ```

   在编辑器中写入：

   ```ini
   [Service]
   EnvironmentFile=%h/.hermes/a2a-connector.env
   ```

   保存后执行（命名 profile 或 system service 请替换为实际 unit 和 scope）：

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart hermes-gateway.service
   systemctl --user status hermes-gateway.service --no-pager
   ```

   以上是默认 profile 的 user service 示例。用 `hermes gateway status` 和 `systemctl --user list-units 'hermes-gateway*'` 确认服务范围和 unit 名称；命名 profile 的独立 service 使用它自己的 unit，multiplex Gateway 使用默认 Gateway 的 unit。若安装为默认 profile 的 system service，执行 `sudo systemctl edit hermes-gateway.service`，再按同样顺序运行 `sudo systemctl daemon-reload`、`sudo systemctl restart hermes-gateway.service` 和 `sudo systemctl status hermes-gateway.service --no-pager`。命名 profile 请替换为实际 unit。不要把 `Environment=` 直接写回生成的主 unit。Hermes 的 Gateway 管理方式见[官方文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)。

   重启后在同一 profile 运行 `hermes plugins list`，确认 `a2a-connector` 已启用；再在 Agent 中确认 `a2a_connector_pair` 工具和 `/a2a_connector pair|start|stop` 命令已注册。Connector 的启动 Hook 是 `on_session_start`，重启 Gateway 本身不会触发它；如需立即启动，在目标 Agent 中执行 `/a2a_connector start`，或者开始一个会话触发 Hook。不要仅凭 Gateway 已监听本机端口判断 Connector 已启动。

### DSH

1. 在目标 DSH Agent 主机安装 `plugins/dsh`。被调度节点只需 adapter + Connector，只有需要向其他节点发起调用时才另装 `dsh-a2a` 客户端。当前 Relay 主控认证使用 Connector 身份，因此中央 DSH 采用此认证模式时也需安装并配对，随后由管理员在 `/pair/list` 设为主控。
2. 用 DSH CLI 将本地插件目录作为目标 profile 的依赖安装：

   ```bash
   dsh plugin --profile "web" add "file:/absolute/path/to/repository/a2a-connector/plugins/dsh"
   ```

   替换示例仓库路径和 `web` profile 为目标主机上的实际值。这个包没有 `dsh.bundle` 声明，CLI 只会把它安装为 profile 依赖；还必须在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 合并以下 Cordis 条目，才能激活插件。先检查已有 patch，避免插入重复的 `id`：

   ```yaml
   - insert:
       - id: dsh-a2a-adapter
         name: dsh-a2a-connector/adapter
         config:
           port: 9900
           name: DSH Agent
           tokenEnv: MY_LOCAL_AGENT_TOKEN
       - id: a2a-connector
         name: dsh-a2a-connector
         config:
           relay: wss://dsh-relay.chuanbota.com/connect
           local: http://127.0.0.1:9900
           localTokenEnv: MY_LOCAL_AGENT_TOKEN
           # 可选稳定 ID：
           # agentId: my-agent
   ```

   adapter 在同一 DSH 进程内调用原生 Agent/session API，提供 `/.well-known/agent-card.json` 和 `/rpc`（A2A v1.0 JSON-RPC）。它仅监听 `127.0.0.1`，必须配置不少于 32 字符的随机 token。把 token 安全写入宿主进程环境中的 `MY_LOCAL_AGENT_TOKEN`，adapter 和 Connector 引用同一变量名；不要写入 patch 或打印到对话。使用已配置模型的常驻 profile（如 `web`），不要使用自动退出的 `headless` profile。

   同一 `contextId` 复用原生 DSH session，完成后追问只携带 `contextId`。支持文本发送、查询、取消和任务列表，不支持流式、推送及暂停任务续传。同会话只允许一个任务运行。最多保留 128 个上下文、4096 个任务；空闲 1 小时释放会话及任务索引。DSH 会 flush 会话日志，但当前 adapter 的 A2A ID 映射仅在内存：重启或过期后旧 ID 会明确报错，需新建会话，不会悄悄重建空历史。

   Connector 配置键还支持 `binary`、`state`、`allowInsecure`。保持 `allowInsecure` 为 `false`。注意：Cordis loader 根据 `name` 解析并动态 `import()` 依赖包，此处 `name` 必须对应 `package.json` 中的包名 `dsh-a2a-connector`（而非 `a2a-connector`），而 `id` 为该插件条目的唯一标识。

3. 插件代码或依赖升级后，必须重新安装并重启运行该 profile 的 DSH 进程；HMR 不保证刷新模块缓存。只有配置变更时，如果 profile 已启用 `dsh-hmr`，Cordis patch 变更会被监听并热加载；否则重启运行该 profile 的 DSH 进程。启动前可检查最终组合，运行 CLI profile 则用 `dsh --profile "web" --dump-config`；确认只出现一个 `id: a2a-connector`（`name: dsh-a2a-connector`）条目，再通过 DSH 平常的启动入口重启同一 profile。启动后确认插件加载且 `a2a_connector_pair` 工具可调用。DSH profile patch 与 HMR 行为见[官方 loader 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)。

### DSH 常驻运行（launchd / systemd）

adapter 与 Connector 都随 DSH profile 生命周期启动。仓库提供 [常驻模板与部署步骤](deploy/README.md)：使用已完成模型配置的 profile，在服务环境中提供 Node/DSH 绝对路径、工作目录和本机认证变量。关闭终端后由服务管理器维持进程，异常退出自动重启；不要另起重复实例占用相同端口或状态文件。

### Tencent WorkBuddy

1. 使用 WorkBuddy 的插件/连接器安装入口安装完整的 `plugins/workbuddy` 目录。它自带 CLI、skill 和 Node 22 runtime 声明。
2. 在 WorkBuddy 终端执行：

   ```bash
   workbuddy-a2a auth login
   ```

   按提示输入 Relay WSS `/connect` URL 和本机 A2A origin。命令会生成配对请求并启动 Connector。

3. 用 `workbuddy-a2a auth status` 查看配对状态；管理生命周期可用 `workbuddy-a2a start` 和 `workbuddy-a2a stop`。

## 配对与授权边界

1. Connector 首次启动后，会显示 Relay `/pair` 审批页、Agent ID 和六位确认码。Agent 可调用 `a2a_connector_pair` 或对应宿主命令查看待审批信息。
2. 对当前 Relay，把审批 URL、Agent ID 和确认码一并交给用户/Relay 管理员。URL 用来打开页面；管理员应在页面中核对 Agent ID 与六位确认码，确认两者匹配后再批准。**不要索取或输入 Relay 管理员 token，也不要代替管理员批准配对。**
3. 获批后 Connector 会自行注册、保存 Agent 专属凭据并连接。凭据默认保存在用户配置目录下的 `a2a-connector` 私有状态文件中，权限为 `0600`；不要读取、打印、复制或提交该文件。
4. 管理员确认码不是 Connector 凭据。等待审批期间不要创建第二个请求；待请求会持久化并在十分钟后过期。过期后 Connector 的自动配对循环会清理旧请求并重新申请；若后台进程已停止，重新调用 `a2a_connector_pair` 或 `/a2a_connector pair` 会检查并创建新请求。不要手动删除状态文件。

## 按顺序验证与排错

按依赖顺序检查，前一项未通过时先修复再继续：

1. **运行时**：确认 Connector 实际使用的 Node.js 为 22+。Hermes 默认执行 `node`；如果服务 PATH 不包含 Node，设置 `A2A_NODE_BINARY` 为绝对路径，并在 Hermes 服务环境中重启后验证。
2. **本机 Agent**：从 Connector 主机请求 `<local origin>/.well-known/agent-card.json`，确认返回 200 且 JSON 有 `name`。如需本机认证，Hermes 用 `A2A_LOCAL_TOKEN` 传入 token 值；OpenClaw/DSH 用 `localTokenEnv` 指定已有环境变量名。
3. **插件加载**：确认宿主插件已启用并且 `a2a_connector_pair` 工具可调用。Hermes 需要执行 `hermes plugins enable a2a-connector`，然后重启目标 Gateway；该命令本身不会重启已运行的 Gateway。
4. **配对申请**：调用 `a2a_connector_pair` 获取当前请求的 URL、Agent ID、确认码。确认码过期后再次调用以显示新请求；不要删除 Connector 状态文件。
5. **管理员批准与运行状态**：管理员核对 Agent ID 和确认码并批准后，再调用 `a2a_connector_pair` 确认已配对。该工具返回 `status: paired` 只证明本地有配对凭据，不能证明子进程或 Relay 连接仍活跃。Hermes 用 `pgrep -af 'vendor/connector/cli.js'` 查看实际进程，并核对命令行中的 vendor 路径是当前插件目录；再读取状态文件旁的 `.pid`，用 `ps -p <PID> -o pid=,args=` 确认 PID 与进程一致。自定义 `A2A_CONNECTOR_STATE` 时 PID 文件也随之改变。Hermes 子进程退出后运行 `/a2a_connector start`；WorkBuddy 运行 `workbuddy-a2a start`；OpenClaw 执行 `openclaw plugins reload a2a-connector`；DSH 重启运行该 profile 的进程。Connector 自身会处理普通网络断线并自动重连。连接问题优先检查 Relay WSS 地址、本机 Agent 可达性、token 环境变量和 Node 绝对路径；不要直接重配对，因为复用 Agent ID 会轮换凭据。

### `file:` 路径失效

如果 DSH plugin reconcile 报目录不存在，检查目标 profile `package.json` 的 `file:` 依赖是否指向已移动或删除的目录。恢复原目录，或执行 `dsh plugin --profile <profile> remove dsh-a2a-connector`，再用本机真实绝对路径 add；保留其他依赖和 Cordis patch。CLI 自身的 reconcile 提示/恢复行为属于 DeepSeek 上游，本仓库只提供排错说明，不把该环境问题当作 Connector 缺陷。

## 完成检查

按上述 1 到 5 的顺序完成检查。向用户报告当前状态是“等待管理员批准”还是“已配对并运行”，不要展示任何 token。
