# DSH 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)，确认目标 DSH profile 名称，然后按以下步骤安装。不要默认安装到其他 profile。

## 安装与配置

若 DSH 已有可访问的 A2A origin（例如 adapter 已配置），且不需要宿主内的配对工具，可改用[独立 Connector 安装脚本](../../scripts/install-connector.sh)：从仓库根目录执行 `sh scripts/install-connector.sh install --host dsh --instance reviewer --expect-name 'DSH Code Reviewer' --relay wss://dsh-relay.chuanbota.com/connect --local auto --port-start 9900`。脚本会在已启动的本机服务中按 Agent Card `name` 找到实际端口；此路径不会配置 DSH adapter 或下方插件，不要同时运行两种路径连接同一个 Agent。

1. 在目标 DSH Agent 主机安装 `plugins/dsh`。这个包只需注册**一个** `dsh-a2a-connector` 条目：未配置已有本机 A2A origin 时，插件自动启动内置服务，再启动 Relay Connector；配置 `agents` 后，同一条目还会注册向外调用 Agent 的工具和 Subagent Provider。Relay 主控认证使用 Connector 身份，管理员须在 `/pair/list` 授权其要调用的目标。
2. 用 DSH CLI 将本地插件目录作为目标 profile 的依赖安装：

   ```bash
   dsh plugin --profile "web" add "file:/absolute/path/to/repository/a2a-connector/plugins/dsh"
   ```

   替换示例仓库路径和 `web` profile 为目标主机上的实际值。这个包没有 `dsh.bundle` 声明，CLI 只会把它安装为 profile 依赖；还必须在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 合并以下 Cordis 条目，才能激活插件。先检查已有 patch，避免插入重复的 `id`：

   `pnpm peers check` 在仅把此包列为 profile 直接依赖时可能提示缺少 DSH SDK peer；DSH 的基础 bundle 会提供运行时服务。以目标 profile 的实际启动和 `a2a_connector_pair`、`a2a_agents` 注册结果为准，不要为了消除提示再装一份 SDK 副本。

   ```yaml
   - insert:
       - id: a2a-connector
         name: dsh-a2a-connector
         config:
           relay: wss://dsh-relay.chuanbota.com/connect
           local: auto
           port: 9900
           portAttempts: 20
           name: DSH Code Reviewer
           description: 审查 Go 和 JavaScript 代码，给出可验证的修改建议。
           skills:
             - id: code-review
               name: Code review
               description: 检查代码逻辑、权限边界与回归风险。
               tags: [code, review]
           # 同一进程运行多个 DSH Agent 时，给每个实例不同的绝对路径：
           # state: /absolute/path/to/private/dsh-reviewer.json
           # 可选稳定 ID：
           # agentId: my-agent
   ```

   内置服务在同一 DSH 进程内调用原生 Agent/session API，提供 `/.well-known/agent-card.json` 和 `/rpc`（A2A v1.0 JSON-RPC）。`name`、`description`、`skills` 会发布到 Agent Card，供主控发现职责；不配置时使用通用 DSH 描述。它仅监听 `127.0.0.1`；插件启动时生成私有随机 token，只传给它管理的 Connector 子进程，无需在 patch 或环境文件中配置本机 token。使用已配置模型的常驻 profile（如 `web`），不要使用自动退出的 `headless` profile。

   `local: auto` 是默认值：**启动包内服务**，并把实际绑定端口直接交给同一插件管理的 Connector；不会扫描其他进程或误连别的 Agent。`port` 是起始监听端口；只有遇到 `EADDRINUSE` 才逐个尝试下一个端口，最多 `portAttempts` 个，默认 20。若当前 DSH Agent 已有可信的 A2A HTTP origin，改成明确的 `local: http://127.0.0.1:<port>`，这时不会启动包内服务；该服务要求 Bearer token 时再配置 `localTokenEnv`。多个 Agent 仍须使用各自的 Connector `state` 绝对路径及可区分的 Agent Card `name`，否则端口虽分开，也会争用配对身份。

   **从旧版升级**：删除原来的 `id: dsh-a2a-adapter` / `name: dsh-a2a-connector/adapter` 条目，以及它的 `portKey`、`tokenEnv`；从 Connector 条目删除 `adapterKey`，将 `port`、`portAttempts`、`name`、`description`、`skills` 合并到唯一的 `id: a2a-connector` 条目。旧 `localTokenEnv` 若只供旧 adapter 使用也可删除。保留原有 `state` 文件和配对凭据；重启目标 profile 后只应看到一个对应条目。旧版单独的 `/adapter` 导出已移除。

### 合并原 `dsh-a2a` 出站能力

需要让 DSH 调用其他 Agent 时，在**同一个** `id: a2a-connector` 的 `config` 下加入远端列表和会话存储路径，例如：

```yaml
storePath: /absolute/path/to/private/a2a-conversations.json
agents:
  - id: reviewer
    card: https://dsh-relay.chuanbota.com/agents/reviewer/.well-known/agent-card.json
    purpose: 审查代码并给出修改建议
```

这里的 `storePath`、`agents` 与旧 `dsh-a2a` 配置含义相同；迁移时沿用**原有** `storePath` 可保留会话索引。不填 `storePath` 时，默认写在 Connector `state` 路径旁的 `.conversations.json` 文件。出站访问 Relay 自动读取同一条目的配对状态，若原先显式使用其他状态文件，可设置 `connectorState`。直接访问其他 A2A 服务时，`agents` 项仍可使用旧版 `url`、`tokenEnv`、`apiKeyEnv`、`allowHttp`、`allowedOrigins` 等字段。`agents` 未配置时不注册出站工具。

出站请求 `requestTimeoutMs` 默认 600000 ms（10 分钟）。Relay HTTP 等待默认 9 分钟；推荐保持 **Relay 等待 < Connector HTTP 超时 < 公网反代读取超时**，例如 9 / 10 / 11 分钟。9 < 10 本身是正确顺序，不代表超时配置有误。Relay 额外以 `processingTimeout`（默认 30 分钟）保留首次派发的迟到响应，并以 `requestRetention`（默认 24 小时）保存查询/去重记录；不是取消远端任务的时间。Relay 启动校验 `timeout < processingTimeout < requestRetention`。各节点无法自动获知对方和反代的配置，需一起核对。

Subagent 总等待默认 `taskTimeoutMs: 1800000`，从派发时开始计时；到期尽力请求取消并报告超时。轮询从 `pollIntervalMs`（默认 1000 ms）指数退避至 `maxPollIntervalMs`（默认 30000 ms），带抖动；429 按 `Retry-After` 进入该目标的本地冷却，停止当前轮询，不自动重发消息。远端仍应及时返回 taskId；`returnImmediately` 是请求选项，不能保证远端遵守。Push capability 只表示对端支持回调，当前尚未安装可鉴权回调通道。

`a2a_send` 在 HTTP 派发前保存 `conversationId`、稳定 `messageId` 和 `relayRequestId`。内联完成的 Task 直接返回去重后的正文；工具保留数字 `state`，并增加 `stateName`。若返回 `dispatchState: unknown`（如 504/断网），按以下步骤处理：

1. 从返回值取得 `conversationId`；调用中止未展示返回值时，用 `a2a_conversations` 找到待派发/未知记录。
2. 调用 `a2a_reconcile({conversation_id: "..."})`。新版 Relay 可返回迟到的 Task 或 Message 正文，不需要再次发送。旧 Relay 仅在已知 contextId 且远端 history 包含该 messageId 时，才可能通过 ListTasks 匹配。
3. 换 DSH session 后，显式调用 `a2a_conversations({include_previous_sessions: true})` 和 `a2a_reconcile({conversation_id: "...", include_previous_sessions: true})` 进行只读查询。历史查询不转移所有权；续聊/取消仍需要原 session。这个 store 是同一本机 profile 的共享查询边界，多用户应使用不同 storePath/凭据。
4. `outcome: unknown`、空列表、404、过期索引都**不能证明未执行**，不自动重发。`safeToResubmit` 保持 false；应继续对账或核对远端执行记录。需要显式幂等键时，`a2a_send` 可带 `message_id`，同键只能用于同一派发和同一内容；本地已知键只对账，新版 Relay 也会去重。新生成的 messageId 是新派发，不按正文自动合并。

会话索引在写入时清理超过 30 天的终态记录，并限制为 4096 条；运行/未知记录不自动删除，全部占满时拒绝新派发并要求先对账。启动会查询新版 Relay 的 `/pairing/targets` 并把未授权/离线目标写入近期诊断，`a2a_agents` 也会刷新目标授权和 Card 状态。`available` 仅代表出站 Card 读取；`targetTunnelOnline` 是远端隧道快照，本机入站健康需调用 `a2a_connector_status`。

升级时把旧 `id: subagent-a2a` 条目下的 `storePath`、`agents`、`pollIntervalMs`、`requestTimeoutMs` 等配置移入此条目，然后移除旧条目和 `dsh-a2a` profile 依赖；若仍使用 `@deepseek-ai/dsh-tool-subagent` 包装工具，保留其 `provider: a2a:<agent-id>` 配置。先验证 `a2a_agents`、一次远端任务和续聊，再删除旧项目目录。不要删除原会话存储文件。

   同一 `contextId` 复用原生 DSH session，完成后追问只携带 `contextId`。支持文本发送、查询、取消和任务列表，不支持流式、推送及暂停任务续传。同会话只允许一个任务运行。最多保留 128 个上下文、4096 个任务；空闲 1 小时释放会话及任务索引。DSH 会 flush 会话日志，但当前 adapter 的 A2A ID 映射仅在内存：重启或过期后旧 ID 会明确报错，需新建会话，不会悄悄重建空历史。

   Connector 配置键还支持 `binary`、`state`、`allowInsecure`。保持 `allowInsecure` 为 `false`。注意：Cordis loader 根据 `name` 解析并动态 `import()` 依赖包，此处 `name` 必须对应 `package.json` 中的包名 `dsh-a2a-connector`（而非 `a2a-connector`），而 `id` 为该插件条目的唯一标识。

3. 插件代码或依赖升级后，必须重新安装并重启运行该 profile 的 DSH 进程；HMR 不保证刷新模块缓存。只有配置变更时，如果 profile 已启用 `dsh-hmr`，Cordis patch 变更会被监听并热加载；否则重启运行该 profile 的 DSH 进程。启动前可检查最终组合，运行 CLI profile 则用 `dsh --profile "web" --dump-config`；确认只出现一个 `id: a2a-connector`（`name: dsh-a2a-connector`）条目，再通过 DSH 平常的启动入口重启同一 profile。启动后确认插件加载且 `a2a_connector_pair` 工具可调用。DSH profile patch 与 HMR 行为见[官方 loader 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)。

### DSH 常驻运行（launchd / systemd）

内置服务与 Connector 都随 DSH profile 生命周期启动。仓库提供 [常驻模板与部署步骤](../../deploy/README.md)：使用已完成模型配置的 profile，在服务环境中提供 Node/DSH 绝对路径和工作目录。关闭终端后由服务管理器维持进程，异常退出自动重启；不要另起重复实例占用相同状态文件。

### `file:` 路径失效

如果 DSH plugin reconcile 报目录不存在，检查目标 profile `package.json` 的 `file:` 依赖是否指向已移动或删除的目录。恢复原目录，或执行 `dsh plugin --profile <profile> remove dsh-a2a-connector`，再用本机真实绝对路径 add；保留其他依赖和 Cordis patch。CLI 自身的 reconcile 提示/恢复行为属于 DeepSeek 上游，本仓库只提供排错说明，不把该环境问题当作 Connector 缺陷。

完成安装后，按[通用配对与验证](shared.md#配对与授权边界)检查审批、凭据和连线。
