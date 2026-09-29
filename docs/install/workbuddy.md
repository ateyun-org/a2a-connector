# Tencent WorkBuddy 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)，然后按以下步骤安装 WorkBuddy 对应的 Connector。包装 CLI 没有公开的 Agent ID 参数；需要固定 ID 时使用原生 CLI 的 `-agent-id`。

本仓库的 `plugins/workbuddy` 包含隧道客户端和管理 CLI，**没有提供把 WorkBuddy 能力暴露为本机 A2A HTTP 服务的 adapter**。全局安装 `workbuddy-a2a` 只注册命令，不能凭此确认 WorkBuddy 已有 `/.well-known/agent-card.json`。若本机没有真正连接到目标 Agent 能力的 A2A origin，先完成该服务端接入，再申请配对。临时 echo/沙箱 origin 只能验证隧道传输，不能算 WorkBuddy Agent 接入成功。

若目标是 **WorkBuddy PC 端本地助理**，腾讯[开放平台文档](https://open.workbuddy.cn/docs/openapi)提供查询在线状态、发送消息和增量读取消息历史的 API。它要求已创建并启用的第三方应用、用户 OAuth 授权，以及 `user.localassistant.invokable` / `user.localassistant.readable` 权限；本仓库尚未实现相应的 A2A 桥接。CodeBuddy Code CLI 的 [`--a2a` stdio 被调模式](https://www.codebuddy.ai/docs/cli/cli-reference)是另一种运行时入口，不能用它代替 WorkBuddy 桌面/沙箱 Agent 的接入验证。

若目标是 **WorkBuddy 云端沙箱里的当前 Agent**，应先验证[云端任务 API 与 ACP 通道](https://open.workbuddy.cn/docs/openapi)：用带 `user.task.readable` 授权的第三方应用查询任务列表，确认当前会话的 `task_id` 出现在列表里，再查询该任务是否返回可用 ACP `link`/`token`，最后验证 `session/load` 能否加载这一已有会话。`user.task.invokable` 可用于新建任务，但新建任务不等于接入当前会话。官方文档列出了这条 API 路径；当前仓库尚未验证该沙箱会话是否可通过这些接口访问，因此不能把它宣称为已接入。不要把 client secret、OAuth token 或 ACP token 放进安装包或对话。

### 开放平台 OAuth 回调

在 Buddy 应用中登记 `https://dsh-relay.chuanbota.com/oauth/workbuddy/callback`。这必须与 Relay 的 `publicUrl` 同源；Relay 部署说明见 [`a2a-relay/README.md`](../../../a2a-relay/README.md#workbuddy-open-api-oauth-callback)。仅保存地址还不能授权：先发布带此路由的新 Relay，并在其**服务端私有环境**配置应用 `client_id`、`client_secret`、允许使用该授权的 Connector Agent ID 和加密密钥。不要把这些值写入本插件、静态 `cli.json`、应用表单的其他字段或聊天。

Connector 已配对且 Relay OAuth 配置就绪后，在 Connector 主机运行：

```bash
workbuddy-a2a platform login
workbuddy-a2a platform status
```

第一条命令打印 WorkBuddy 官方授权 URL；用户打开并同意后，第二条确认已关联。`platform logout` 从 Relay 删除本应用保存的加密 token。Relay 将授权码一次性兑换并加密存储 token，Connector 只用自己的配对凭据访问 OAuth 状态与短期 access token；应用密钥留在 Relay 服务端。该阶段仅完成 Open API 授权，**尚未**证明当前沙箱会话可见，也未提供 WorkBuddy 原生 A2A origin；仍需进行上述任务列表和 ACP 验证。

## 安装与配置

当前仓库能验证的是 **WorkBuddy 包内 CLI 的本机运行路径**；尚未提供可复现的 WorkBuddy 市场源注册流程。不要假定把 `plugins/workbuddy` 复制到某个目录就会出现在 GUI。当前[公开连接器文档](https://open.workbuddy.cn/docs/connector)给出的 CLI + Skill 包基础结构是在提交目录根部放 `connector-meta.json`、`cli.json`、`icon.svg` 和 `skills/`；此前抽样的市场下载包则把 `cli.json` 放在 `ai.workbuddy/` 并带内部清单。两者可能是提交包与分发包的不同阶段，须通过目标版本的实际上传、解析和安装验证，不能仅凭任一静态样例断定另一布局无效。公开文档要求在 `connector-meta.json` 声明使用到的 `minWorkbuddyVersion`，但仍需在目标客户端验证版本闸实际生效。

### 自动安装与诊断

本机 A2A origin 已启动后，从仓库根目录运行以下命令。脚本检查 Node.js、Agent Card 和 token 环境，安装 `ws`，复用已有 pending/凭据，写入非敏感的 WorkBuddy settings，再启动**一个**后台进程。若 origin 要求 Bearer token，先在当前进程环境提供 `A2A_LOCAL_TOKEN`；脚本不会保存 token。管理员仍需在审批页核对 Agent ID 和六位确认码并批准。

```bash
sh scripts/install-connector.sh install --host workbuddy --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900
sh scripts/install-connector.sh status --host workbuddy
```

同机运行多个 WorkBuddy A2A origin 时，每个服务须先在其自身配置中监听不同端口，并使用不同的 Agent Card `name`。安装脚本用 `--instance` 隔离状态、PID、日志和进程名；`--local auto` 从指定起始端口扫描**已经启动**的服务，只有 Agent Card 名称与 `--expect-name` 完全匹配才接入：

```bash
sh scripts/install-connector.sh install --host workbuddy --instance reviewer --expect-name 'Review Agent' --relay wss://dsh-relay.chuanbota.com/connect --local auto --port-start 9900
sh scripts/install-connector.sh status --host workbuddy --instance reviewer
```

此实例的文件使用 `workbuddy-reviewer.*` 前缀，后台 Connector 标题带独立的状态路径指纹；使用包装 CLI 检查或停止它时，传入 `A2A_CONNECTOR_INSTANCE=reviewer` 环境变量。脚本不能替 WorkBuddy 或其他外部 Agent 修改其内置 A2A 服务的监听端口；若服务因 9900 冲突而没启动，先在该服务的启动配置中改端口。扫描时匿名读取 Card，不会把本机 Bearer token 发往未确认的端口；遇到两个同名 Card 会报错。若 Card 必须认证，改用明确的 `--local http://127.0.0.1:<port>`，同时保留 `--expect-name` 校验。

需要停止时执行 `sh scripts/install-connector.sh stop --host workbuddy`。只有在 `status` 提示 401/409、已经核实没有有效凭据，并按[通用恢复顺序](shared.md#兑换失败重复申请与安全恢复)检查 `.state-*` 后，才执行：

```bash
sh scripts/install-connector.sh repair --host workbuddy --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900
```

`repair` 会停止脚本管理的进程、归档失效 pending 并重新申请；发现可能含凭据的临时文件或已有凭据时会停下，不会覆盖。后台 stderr 保存在私有的 `~/.config/a2a-connector/workbuddy.stderr.log`；`status` 只摘要提示 401/409，不输出凭据。该脚本连接的是指定的本机 A2A origin，**不会**让包自动出现在 WorkBuddy GUI。脚本用法见 `sh scripts/install-connector.sh --help`。

验收时应确认三件事：Agent Card 指向预期的真实 A2A 服务；批准后 Relay 显示在线；最后由有权限的远端调用者发起一个会触达 **WorkBuddy 实际能力**的任务并核对结果。`Logged in`、已保存凭据、443 端口的 WSS 连接或 echo 响应，只证明对应的局部环节，不能代替最后一项。

### 手动 CLI 路径

下面的步骤可让同一台机器上的 WorkBuddy A2A origin 接入 Relay，但不会自动把连接器注册到 WorkBuddy GUI：

1. 安装包依赖并确认 Node.js 22+。从仓库根目录执行：

   ```bash
   npm ci --prefix plugins/workbuddy
   node --version
   ```

   要使用下文的交互式 `workbuddy-a2a` 命令，先在 `plugins/workbuddy` 目录执行 `npm install -g .`，并确认 `workbuddy-a2a` 在 PATH 中；`-g` 仅安装命令入口，运行时仍以 CLI 自身的位置寻找随包的 `vendor/connector`。只走非交互原生 CLI 路径则不需要全局安装。更新此包时保留私有状态目录，退出/卸载前先停止进程；`auth logout` 会移除本地凭据，但不会卸载 npm 包。

2. **只启动一个**使用 `~/.config/a2a-connector/workbuddy.json` 的 Connector 进程。在交互式终端执行：

   ```bash
   workbuddy-a2a auth login
   ```

   按提示输入 Relay WSS `/connect` URL 和本机 A2A origin。命令先保存待审批请求，再启动后台 Connector；不要在等待审批时再次执行 `auth login`、`start` 或另开一个原生 CLI 轮询同一状态文件。

   非交互环境可直接运行随包的原生 CLI。以下 `-request-only` 只提交/复用请求并输出公开审批信息，**不会**启动后台轮询；提交后只启动一个 `-auto-pair` 进程，或在获批后用下文的一次性兑换方式。不要同时使用两种方式：

   ```bash
   node plugins/workbuddy/vendor/connector/cli.js -relay wss://dsh-relay.chuanbota.com/connect -local http://127.0.0.1:9900 -state "$HOME/.config/a2a-connector/workbuddy.json" -request-only
   node plugins/workbuddy/vendor/connector/cli.js -relay wss://dsh-relay.chuanbota.com/connect -local http://127.0.0.1:9900 -state "$HOME/.config/a2a-connector/workbuddy.json" -auto-pair
   ```

   在非交互路径中，`workbuddy-settings.json` 不会自动生成，因此 `workbuddy-a2a start` 不能接管该进程，`auth status` 也可能误报未登录。继续用相同的原生 CLI 参数管理它。若本机 origin 需要 Bearer token，在**启动 Connector 的进程环境**中提供 `A2A_LOCAL_TOKEN`；包装 CLI 的 `login`/`start` 会继承当时的环境，但不会保存 token。重开终端、登录会话或服务重启后必须再次注入。不要把 token 放进 `cli.json` 的静态 `env`、shell 历史、命令参数或聊天内容。

3. 交互式路径用 `workbuddy-a2a auth status` 查看审批信息，用 `workbuddy-a2a stop` / `start` 控制后台进程。`start` 会拒绝重复启动同一实例；若提示正在启动或 PID 文件仍指向活进程，先核实该进程，不要再手动起一个原生 CLI。`Logged in` 当前要求凭据文件、PID 文件和进程同时存在；进程退出时即使凭据仍有效也可能显示 `Not logged in`。`start` 打印 `Connector started` 仅表示子进程已派生，仍须按下文检查 Relay 连接。

   WorkBuddy 文件均在 `~/.config/a2a-connector/`：`workbuddy.json` 是含 token 的凭据，`workbuddy.json.pending` 是待审批请求，`workbuddy-settings.json` 保存 relay/local 等非 token 设置，`workbuddy.pid` 记录后台 PID，`workbuddy.stderr.log` 保存子进程输出。它们与 Hermes、DSH 的状态文件彼此独立。不要展示文件正文或把它们提交到仓库。

## WorkBuddy 故障恢复

`Not logged in` 也可能表示 PID 文件不存在、进程已退出，或非交互路径没有 settings 文件；不能单凭这条输出断定凭据失效。先按[通用恢复顺序](shared.md#兑换失败重复申请与安全恢复)停止同一状态路径的进程，并检查是否已有可用凭据。交互式路径可先执行 `workbuddy-a2a stop`；仍要用 `pgrep -af 'vendor/connector/cli.js'` 核对是否有原生 CLI 或旧包进程。

完成停进程和凭据检查后，可以只查看文件名/权限，并归档**已确认失效**的 pending；不要用 `cat`、`jq`、`grep` 展示凭据内容，也不要整目录上传：

```bash
state_dir="$HOME/.config/a2a-connector"
ls -ld "$state_dir"
ls -l "$state_dir"/workbuddy.json "$state_dir"/workbuddy.json.pending "$state_dir"/.state-* 2>/dev/null || true
# 仅在确认 workbuddy.json 不存在、.pending 已失效且所有相关进程都停止后：
mv "$state_dir/workbuddy.json.pending" "$state_dir/workbuddy.json.pending.backup-$(date +%Y%m%d-%H%M%S)"
```

WorkBuddy 原生 CLI 还支持在已取得 `pair_` 码、且没有另一个兑换进程时，以 `A2A_PAIR_CODE` 和 `-enroll-only` 做一次性兑换；六位确认码不能用于此步骤。不要把 `pair_` 码或本机 Bearer token 放入 `cli.json` 的静态 `env`、命令历史或聊天内容。

WorkBuddy 自带的**出站** A2A 调用能力与本 Connector 的**入站** Relay 隧道方向不同。若只需 WorkBuddy 向外调用 Agent，先确认宿主功能是否已满足需要；若要让远端调用 WorkBuddy PC 本地助理，可评估上文的官方 Open API 授权路径。

## 从 WorkBuddy 调用其他 Agent

已配对的 WorkBuddy 实例可以复用自身凭据，经 Relay 调用获授权的目标。管理员须先在 Relay `/pair/list` 给**当前 WorkBuddy Agent ID** 授予目标 Agent 的访问权限；否则请求返回 403。目标 ID 从管理员列表或可信的 Agent Card 获取，不通过猜测生成。以下命令从标准输入读取任务，返回 JSON（含状态、任务 ID、上下文 ID 和文本结果）；需要长时间执行的任务在 120 秒后报出任务 ID，先用 `task` 查询其状态再决定是否重试，避免重复执行：

```bash
printf '%s\n' '请审查这个改动' | workbuddy-a2a call reviewer-agent-id
workbuddy-a2a task reviewer-agent-id <task-id>
```

多实例时设置 `A2A_CONNECTOR_INSTANCE`，以选中对应的配对状态。该命令只访问配置的 Relay，并检查 Agent Card 给出的 JSON-RPC 地址仍位于该 Relay 的目标路径下，避免把配对凭据发往任意 URL。它支持文本任务，不提供附件、交互审批或持久的多轮上下文；这些能力需要单独实现和验证。WorkBuddy GUI 是否能直接调用这个命令，取决于插件的发现与工具注册，不能把 CLI 可用等同于 GUI 已集成。

反方向仍要求一个能把 `SendMessage` 真正转发到目标 WorkBuddy Agent 的本地 A2A origin。当前包没有这样的服务。若目标为 PC 本地助理，可在取得开放平台应用和用户授权后实现 Open API 适配；若目标为此次测试中的沙箱会话，必须先确认该会话的受支持调用入口及会话绑定方式，不能用新建的 echo Agent 冒充它。

完成安装后，按[通用配对与验证](shared.md#配对与授权边界)检查审批、凭据和连线。
