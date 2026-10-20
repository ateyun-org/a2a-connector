# Tencent WorkBuddy 接入任务协作

若目标是把能力绑定到“传播塔” Buddy 应用，使用新增的[远程 MCP 应用接入指南](workbuddy-mcp.md)。本页介绍受控适配器和 CLI 诊断；CLI ZIP 与 MCP 连接器 ZIP 是不同的分发包。服务管理器可用 `workbuddy-a2a run` 以前台方式运行既有实例。

`plugins/workbuddy` 支持两个方向：WorkBuddy 主控通过 Relay 调用其他已授权 Agent；WorkBuddy 受控通过内置 A2A adapter 执行任务。受控端有 `desktop`（PC 本地助理 Open API）与 `cloud`（云端任务 Open API + ACP）两种模式。`setup` 启动 adapter 和一个 Connector，不要求预先准备外部 A2A origin。

云端模式可以新建会话，也能绑定已有云端 task ID；同一 A2A context 的后续轮次复用对应云端会话。两种模式都可以在具备 Node.js 22 和持续网络连接的主机运行；云端受控执行无需 PC 助理在线。WorkBuddy 云端作为主控时，须在其可执行命令的环境内安装 CLI、配对并获得目标访问权限；仅填写应用提示词不会授予工具能力。

## 安装与启动

首次接入时，CLI 会显示配对、账号授权和执行模式对应的设置顺序。GUI 的 `auth connect` 在配对完成后提供接入引导页；`platform login` 也进入同一引导页。页面先跳转 WorkBuddy 官方账号授权，回调成功后继续显示桌面远程连接设置和检查步骤。云端模式不要求桌面远程连接开关。

连接器 GUI 使用 `connection status` 同时检查配对、实时隧道、WorkBuddy 账号授权和当前模式的平台可用状态，未完成账号授权时不会匹配「Logged in」。`auth status` 仍只用于配对诊断。配对审批完成后若连接器还提示未连接，再点一次连接即可进入账号授权。`doctor` 的 `nextActions` 给出缺失步骤；桌面开关只能人工确认，不把在线状态当成远程控制已启用。

先阅读[通用配对说明](shared.md)。在仓库根目录安装依赖与 CLI，要求 Node.js 22+：

```bash
rtk npm ci --prefix plugins/workbuddy
rtk npm install -g ./plugins/workbuddy
rtk proxy workbuddy-a2a setup --relay wss://dsh-relay.chuanbota.com/connect --name '传播塔 WorkBuddy'
rtk proxy workbuddy-a2a auth status
```

`setup` 使用系统分配的 loopback 端口启动真实的 PC adapter。Card/RPC 均要求独立 Bearer token；token 每次启动随机生成，只在进程间传递，不写入 settings、安装包或日志。Connector 向 Relay 发布 Card 时重写接口地址。

`auth status` 显示待审批 Agent ID、六位确认码和审批地址。管理员在 `/pair` 核对后批准。`Logged in` 要求隧道健康，而非仅有凭据文件；这仍不代表 WorkBuddy Open API 已授权。

```bash
rtk proxy workbuddy-a2a stop
rtk proxy workbuddy-a2a start
```

`stop` 停止本地 adapter 和隧道，不会假装取消已送到 WorkBuddy 的任务。重启恢复查询已有任务，不重新发送。

`A2A_CONNECTOR_INSTANCE` 可隔离多实例（最长32字符的小写字母、数字、下划线或连字符）；每个实例有独立身份、进程、任务记录及动态端口。`A2A_CONNECTOR_CONFIG_DIR` 可指定私有状态目录，默认 `~/.config/a2a-connector/`。已有 settings 不匹配时不会覆盖，须先检查或使用另一实例。

## 云端模式

首次配置云端受控 Agent（与已有桌面实例使用不同 instance）：

```bash
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a setup --mode cloud --relay wss://dsh-relay.chuanbota.com/connect --name '传播塔云端'
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a auth status
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a platform login
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a doctor
```

如需操作现有云端会话，在**第一次 setup** 时追加 `--task-id ACTUAL_CLOUD_TASK_ID`，可选 `--cwd /workspace`。task ID 是云端会话 ID，不是 Buddy 应用 ID。绑定后始终使用指定会话；不存在、无权访问或不可用时直接失败，不偷偷新建。绑定模式的所有 context 共用该会话，应避免手动对话并发。创建模式中，不带 context 的新任务建立新会话；`call TARGET --context-id RETURNED_CONTEXT_ID` 用于完成后的追问。

```bash
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a cloud tasks
rtk proxy env A2A_CONNECTOR_INSTANCE=cloud workbuddy-a2a cloud task ACTUAL_CLOUD_TASK_ID
```

列表返回第一页最多100条；查询命令只输出 task ID、名称与状态，不输出 OAuth 或 ACP 凭据。`doctor` 在云端模式检查权限、任务列表及绑定会话可用状态，不创建任务；执行时再验证 ACP 建连与加载能力。

新建会话先提交仅要求 `READY` 的初始化指令，待其空闲或完成，再用 ACP `session/prompt` 提交实际任务一次，避免创建接口和 ACP 重复执行同一条业务指令。初始化本身可能使用平台额度。ACP 通过认证 SSE + POST 双通道通信，按 initialize、session/load、session/prompt 顺序调用；旧历史不混入新轮次结果。只有当前 prompt 的最终响应 `stopReason=end_turn` 才报告完成，拒绝/取消分别映射为 rejected/canceled，额度或轮次中断保持 input-required。支持流式文本、产物增量更新及删除；返回产物正文或 `agent:///` 位置，不伪造媒体下载地址。

工具审批会返回 `TASK_STATE_INPUT_REQUIRED`，`task` / `adapter task` 的 `metadata.permission` 包含 request ID、工具说明及可选项。收到用户明确选择后，主控可回复：

```bash
rtk proxy workbuddy-a2a permission TARGET_AGENT_ID A2A_TASK_ID '"permission-1"' ACTUAL_OPTION_ID
rtk proxy workbuddy-a2a cancel TARGET_AGENT_ID A2A_TASK_ID
```

permission 的 request ID 参数为 JSON：字符串带双引号，数字保留数字类型；必须使用原请求提供的 option ID。不得为继续执行而自动批准。取消会向 ACP 发送 session/cancel，并等待真实 cancelled 结束响应，发送取消请求不等于任务已经停止。

创建/发送结果未知、ACP 断线或 runner 重启后，保留原 A2A 与云端 task ID，不自动重建或重发；需要用户在原云端会话核实。创建响应丢失时，任务元数据保留唯一 `cloudName=A2A-<A2A_TASK_ID>` 供查询平台任务列表。此类未核实任务会阻止新的受控轮次；不会仅凭会话 idle/completed 或历史文字推断当前轮次成功，也不宣称可跨连接恢复丢失的最终 RPC 响应。

用户检查原云端会话、确认不再执行后，可明确放弃这轮跟踪：`workbuddy-a2a release TARGET_AGENT_ID A2A_TASK_ID`。若创建响应丢失，追加通过 cloudName 找到的云端 task ID；驱动会验证名称匹配及云端已不活跃。该操作仅把未核实记录关闭为 rejected 并释放队列，**不报告执行成功，也不取消远端任务**。不自动调用 release 来绕过未解决状态。

ACP 地址仅信任官方 `acp.workbuddy.cn/sessions/<id>` 和文档中的 `*.agentos-run.net/acp`，禁止重定向及任意外部凭据目的地。ACP token 过期时，在发送业务 prompt 前通过原 task ID 获取新凭据并重建连接；已尝试发送的业务 prompt 不会自动重试。

## 开放平台 OAuth 与 Relay 配置

Buddy 应用登记回调 `https://dsh-relay.chuanbota.com/oauth/workbuddy/callback`。PC 模式申请 `user.localassistant.readable`、`user.localassistant.invokable`；云端模式申请 `user.task.readable`、`user.task.invokable`。Relay 服务端私有环境配置：

```text
WORKBUDDY_CLIENT_ID=<应用Client ID>
WORKBUDDY_CLIENT_SECRET=<应用密钥>
WORKBUDDY_AGENT_ID=<获批的WorkBuddy Connector Agent ID>
WORKBUDDY_TOKEN_KEY=<32字节随机数据的Base64编码>
WORKBUDDY_SCOPES=user.localassistant.readable user.localassistant.invokable
```

仅云端时，SCOPES 改为 `user.task.readable user.task.invokable`；同一获批 Agent 需要两种能力时配置四个权限并重新授权。Relay 当前将 OAuth 限定给一个 `WORKBUDDY_AGENT_ID`；另一个 instance 是不同 Agent 身份，不能共享或复制凭据。若改用云端实例，须同步把该配置改为其获批 Agent ID；此版本不提供一个 Relay OAuth 配置同时授权多个实例的功能。

密钥仅保存在服务端私有环境；加密密钥须跨重启保留。此版本继续使用一个明确的 `WORKBUDDY_AGENT_ID` 保护应用令牌，其他 Agent 不能取得它们。部署及反向代理路径见 [Relay 说明](../../../a2a-relay/README.md#workbuddy-open-api-oauth-callback)。之后运行：

```bash
rtk proxy workbuddy-a2a platform login
rtk proxy workbuddy-a2a platform status
rtk proxy workbuddy-a2a doctor
```

用户在 `platform login` 输出的官方 URL 授权。`doctor` 按当前模式检查配对、实时隧道、应用授权、所需权限与平台可用状态，全部满足才成功退出；它不提交任务或打印 token。

`desktopOnline=true` 仅证明桌面客户端在线，不证明其入站 Claw 通道已启用。若历史返回“该通道尚未配置 / This channel is not configured”，应先在桌面端检查对应通道设置；对于被关闭的微信小程序通道，在左下角“连接移动端 → 小程序”面板检查“允许移动端连接此设备”。启用是用户的访问控制选择，安装程序不自动改写 WorkBuddy 设置。

桌面消息历史兼容字符串和 `{type:"text",text:"..."}` 文本块，以及空 `msg_type`。匹配任务 ID 的最终 JSON 才能报告任务完成；`metadata.state=exec_approval` 的审批会报告 input-required。桌面入站策略返回的明确“通道尚未配置”拒绝报告 rejected，保留原任务及提供方原因，不自动重发。成功空轮询不再刷新任务进度时间戳。相关设置入口见[官方多端协同说明](https://www.workbuddy.cn/docs/workbuddymini/features/Multidevice)。

退出接入时先用 `platform logout` 清理 Relay 的加密 OAuth 会话，再用 `auth logout` 停止进程并移除本地配对凭据。

## WorkBuddy 作为主控

管理员在 `/pair/list` 为当前 WorkBuddy Agent 授予指定目标的调用权限。`targets` 只显示已获授权的目标：

```bash
rtk proxy workbuddy-a2a targets
rtk proxy workbuddy-a2a call ACTUAL_TARGET_ID --message-id UNIQUE_REQUEST_ID
rtk proxy workbuddy-a2a task ACTUAL_TARGET_ID REMOTE_TASK_ID
```

占位符须替换为实际值。`call` 的任务文本通过 stdin 提供，不放入凭据字段。发送前会保存 message ID 和 Relay request ID 到私有 `workbuddy.json.outbound.json`。结果 JSON 包含 task/context ID、状态、文本和请求编号。

超时或断线后用原错误里的 request ID 查询，不再次发送：

```bash
rtk proxy workbuddy-a2a outbound RELAY_REQUEST_ID
```

它优先查询已记录的远端 task，否则查询 Relay 日志恢复晚到结果。同一 `--message-id` 和内容再次调用时只查旧请求；内容不同会拒绝。只有本地明确记录在发送前检查失败（`dispatched:false`）时，修复后才允许用原 ID 再调用。没有日志、日志过期或状态未知，均不证明原任务未执行。

## WorkBuddy 作为受控

管理员给主控 Agent 授予此 WorkBuddy Agent 的调用权限。主控使用 Card 中的 `SendMessage` / `GetTask`；前者返回持久 task ID，任务在后台继续，后者返回状态和结果。也可本机诊断：

```bash
rtk proxy workbuddy-a2a adapter task TASK_ID
```

PC API 是用户的一条**共享对话**，不是按 A2A context 隔离的沙箱。adapter 同时只接受一个未完成任务；执行中、等待审批或结果未知时拒绝新任务。同一 context 可在上一轮完成后继续，但不承诺与手动桌面对话隔离。

任务发送前持久化且只发送一次。响应丢失或重启后通过任务标记与历史恢复关联；无法确认则保留未知状态、阻止新任务，不自动重发。记录默认保留7天，最多256条；活动和未知记录不会自动清理，容量不足会停止接收，须先归档终态记录。日志含任务内容和结果，应保持私有权限，不得提交到 Git。

官方历史 API 没有独立完成事件。adapter 要求最终回复为带 `a2aTaskId` 的 JSON，状态为 `completed`、`failed` 或 `input-required`。普通文字、中间消息或其他任务的回复不会被当成完成。30分钟未收到关联结果时显示需要人工检查，仍继续查询原任务。

工具审批和问答在 WorkBuddy 桌面处理，不自动批准。PC 模式下 `CancelTask` 明确报告不支持：当前 PC API 没有取消接口，停止 adapter 不等于停止远端执行。支持文本任务与结果；附件上传及任意并发不在此 PC 路径内。云端模式的完成、审批与取消规则见上节。

## WorkBuddy 客户端连接器包

`cli.json` 声明托管 Node.js 22、非交互安装及 `auth connect` / `auth status` / `auth logout`。GUI 认证不等待 stdin：`auth connect` 启动或复用后台服务，输出 Relay 审批 URL 后退出；后台继续配对，客户端只读轮询 `auth status`。Open API 授权另用 `platform login`。`cli.json.env.A2A_RELAY_URL` 为可调整的非敏感部署地址。

```bash
rtk proxy python3 scripts/package-workbuddy.py
```

输出 `dist/workbuddy-a2a-connector-VERSION.zip`。根目录含 `connector-meta.json`、`cli.json`、`icon.svg`、`skills/` 及运行代码。按[官方 CLI + Skill 文档](https://open.workbuddy.cn/docs/connector)上传并通过客户端安装，再加入 Buddy 应用市场。创建 Buddy 应用或全局安装 CLI，不等于注册市场连接器。

本地测试覆盖包结构、两种模式的非交互认证、后台生命周期、真实 Connector 隧道、模拟 PC Open API 和云端 ACP 执行。平台审核、目标客户端安装、真实 OAuth 与真实账号的 PC/云端执行仍须部署后验收；模拟接口通过不代表真实账号已授权。API 契约来源：[WorkBuddy Open API](https://open.workbuddy.cn/docs/openapi)、[ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。

## 自动安装与诊断

旧 `scripts/install-connector.sh --host workbuddy --local ...` 保留为**已有外部 A2A origin** 的兼容入口，不启动此 PC adapter。使用前确认 Card 指向真实服务，不以 echo 代替 WorkBuddy 执行能力：

```bash
rtk proxy sh scripts/install-connector.sh install --host workbuddy --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900
```

修复配对时遵循[通用恢复顺序](shared.md#兑换失败重复申请与安全恢复)，不可因未知结果重复兑换一次性 pairing code 或覆盖凭据。
