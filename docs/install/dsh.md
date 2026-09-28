# DSH 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)，确认目标 DSH profile 名称，然后按以下步骤安装。不要默认安装到其他 profile。

## 安装与配置

若 DSH 已有可访问的 A2A origin（例如 adapter 已配置），且不需要宿主内的配对工具，可改用[独立 Connector 安装脚本](../../scripts/install-connector.sh)：从仓库根目录执行 `sh scripts/install-connector.sh install --host dsh --instance reviewer --expect-name 'DSH Code Reviewer' --relay wss://dsh-relay.chuanbota.com/connect --local auto --port-start 9900`。脚本会在已启动的本机服务中按 Agent Card `name` 找到实际端口；此路径不会配置 DSH adapter 或下方插件，不要同时运行两种路径连接同一个 Agent。

1. 在目标 DSH Agent 主机安装 `plugins/dsh`。被调度节点只需 adapter + Connector，只有需要向其他节点发起调用时才另装 `dsh-a2a` 客户端。Relay 主控认证使用 Connector 身份，因此 DSH 采用此认证模式时也需安装并配对，随后由管理员在 `/pair/list` 授权其要调用的目标。
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
           portAttempts: 20
           portKey: reviewer
           name: DSH Code Reviewer
           description: 审查 Go 和 JavaScript 代码，给出可验证的修改建议。
           skills:
             - id: code-review
               name: Code review
               description: 检查代码逻辑、权限边界与回归风险。
               tags: [code, review]
           tokenEnv: MY_LOCAL_AGENT_TOKEN
       - id: a2a-connector
         name: dsh-a2a-connector
         config:
           relay: wss://dsh-relay.chuanbota.com/connect
           local: auto
           adapterKey: reviewer
           localTokenEnv: MY_LOCAL_AGENT_TOKEN
           # 同一进程运行多个 DSH Agent 时，给每个实例不同的绝对路径：
           # state: /absolute/path/to/private/dsh-reviewer.json
           # 可选稳定 ID：
           # agentId: my-agent
   ```

   adapter 在同一 DSH 进程内调用原生 Agent/session API，提供 `/.well-known/agent-card.json` 和 `/rpc`（A2A v1.0 JSON-RPC）。`name`、`description`、`skills` 会发布到 Agent Card，供主控发现职责；不配置时使用通用 DSH 描述。它仅监听 `127.0.0.1`，必须配置不少于 32 字符的随机 token。把 token 安全写入宿主进程环境中的 `MY_LOCAL_AGENT_TOKEN`，adapter 和 Connector 引用同一变量名；不要写入 patch 或打印到对话。使用已配置模型的常驻 profile（如 `web`），不要使用自动退出的 `headless` profile。

   `port` 是起始监听端口；只有遇到 `EADDRINUSE` 才逐个尝试下一个端口，最多 `portAttempts` 个，默认 20。`local: auto` 让同一包的 Connector 使用 adapter **实际绑定**的端口，因此不用把 `local` 固定写成 9900。`portKey` / `adapterKey` 必须相同，且同一 DSH 进程中的每个 adapter 使用不同的 key；adapter 条目应先于 Connector 条目加载。多个 Agent 还要配置各自的 Connector `state` 绝对路径，否则即使端口分开也会争用配对身份。

   同一 `contextId` 复用原生 DSH session，完成后追问只携带 `contextId`。支持文本发送、查询、取消和任务列表，不支持流式、推送及暂停任务续传。同会话只允许一个任务运行。最多保留 128 个上下文、4096 个任务；空闲 1 小时释放会话及任务索引。DSH 会 flush 会话日志，但当前 adapter 的 A2A ID 映射仅在内存：重启或过期后旧 ID 会明确报错，需新建会话，不会悄悄重建空历史。

   Connector 配置键还支持 `binary`、`state`、`allowInsecure`。保持 `allowInsecure` 为 `false`。注意：Cordis loader 根据 `name` 解析并动态 `import()` 依赖包，此处 `name` 必须对应 `package.json` 中的包名 `dsh-a2a-connector`（而非 `a2a-connector`），而 `id` 为该插件条目的唯一标识。

3. 插件代码或依赖升级后，必须重新安装并重启运行该 profile 的 DSH 进程；HMR 不保证刷新模块缓存。只有配置变更时，如果 profile 已启用 `dsh-hmr`，Cordis patch 变更会被监听并热加载；否则重启运行该 profile 的 DSH 进程。启动前可检查最终组合，运行 CLI profile 则用 `dsh --profile "web" --dump-config`；确认只出现一个 `id: a2a-connector`（`name: dsh-a2a-connector`）条目，再通过 DSH 平常的启动入口重启同一 profile。启动后确认插件加载且 `a2a_connector_pair` 工具可调用。DSH profile patch 与 HMR 行为见[官方 loader 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)。

### DSH 常驻运行（launchd / systemd）

adapter 与 Connector 都随 DSH profile 生命周期启动。仓库提供 [常驻模板与部署步骤](../../deploy/README.md)：使用已完成模型配置的 profile，在服务环境中提供 Node/DSH 绝对路径、工作目录和本机认证变量。关闭终端后由服务管理器维持进程，异常退出自动重启；不要另起重复实例占用相同端口或状态文件。

### `file:` 路径失效

如果 DSH plugin reconcile 报目录不存在，检查目标 profile `package.json` 的 `file:` 依赖是否指向已移动或删除的目录。恢复原目录，或执行 `dsh plugin --profile <profile> remove dsh-a2a-connector`，再用本机真实绝对路径 add；保留其他依赖和 Cordis patch。CLI 自身的 reconcile 提示/恢复行为属于 DeepSeek 上游，本仓库只提供排错说明，不把该环境问题当作 Connector 缺陷。

完成安装后，按[通用配对与验证](shared.md#配对与授权边界)检查审批、凭据和连线。
