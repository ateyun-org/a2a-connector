# Tencent WorkBuddy 接入任务协作

服务端统一托管云端/电脑端执行请优先使用[托管接入指南](workbuddy-hosted.md)：一个 WorkBuddy 接入身份支持两种执行位置，用户电脑无需运行本项目 A2A 服务或 Connector。下面保留单模式接收端和历史 CLI 配置的操作说明。

若目标是把能力绑定到“传播塔” Buddy 应用，使用新增的[远程 MCP 应用接入指南](workbuddy-mcp.md)。本页介绍受控适配器和 CLI 诊断；CLI ZIP 与 MCP 连接器 ZIP 是不同的分发包。服务管理器可用 `workbuddy-a2a run` 以前台方式运行既有实例。

`plugins/workbuddy` 支持两个方向：WorkBuddy 主控通过 Relay 调用其他已授权 Agent；WorkBuddy 受控通过内置 A2A adapter 执行任务。受控端有 `desktop`（PC 本地助理 Open API）与 `cloud`（云端任务 Open API + ACP）两种模式。`setup` 启动 adapter 和一个 Connector，不要求预先准备外部 A2A origin。

云端模式可以新建会话，也能绑定已有云端 task ID；同一 A2A context 的后续轮次复用对应云端会话。两种模式都可以在具备 Node.js 22 和持续网络连接的主机运行；云端受控执行无需 PC 助理在线。WorkBuddy 云端作为主控时，须在其可执行命令的环境内安装 CLI、配对并获得目标访问权限；仅填写应用提示词不会授予工具能力。

## 安装与启动

先使用[控制台身份绑定票据](shared.md#票据接入)完成接入。内置 adapter 没有外部 origin，应在 setup 前通过私有 A2A_PAIR_CODE 执行一次 `workbuddy-a2a auth enroll --relay <wss-url> --agent-id <控制台ID>`；同一实例已有匹配凭据时复用。Relay 原生托管接收端直接用控制台邀请，无需安装本机 Connector。

GUI auth connect 使用已有凭据检查账号授权，未授权时提供官方引导页。connection status 检查隧道、账号和当前模式平台状态；doctor 给出缺失步骤。没有凭据会报告 enrollment_required，不创建审批请求。

先阅读[通用配对说明](shared.md)。在仓库根目录安装依赖与 CLI，要求 Node.js 22+：

```bash
rtk npm ci --prefix plugins/workbuddy
rtk npm install -g ./plugins/workbuddy
# 先私密提供 A2A_PAIR_CODE，兑换成功后清除该环境变量
rtk proxy workbuddy-a2a auth enroll --relay wss://dsh-relay.chuanbota.com/connect --agent-id AGENT_ID_FROM_CONSOLE
rtk proxy workbuddy-a2a setup --relay wss://dsh-relay.chuanbota.com/connect --name '传播塔 WorkBuddy'
rtk proxy workbuddy-a2a auth status
```

`setup` 使用系统分配的 loopback 端口启动真实的 PC adapter。Card/RPC 均要求独立 Bearer token；token 每次启动随机生成，只在进程间传递，不写入 settings、安装包或日志。Connector 向 Relay 发布 Card 时重写接口地址。

`Logged in` 要求实时隧道健康；账号授权与电脑远程连接另行验证。

```bash
rtk proxy workbuddy-a2a stop
rtk proxy workbuddy-a2a start
```

`stop` 停止本地 adapter 和隧道，不会假装取消已送到 WorkBuddy 的任务。重启恢复查询已有任务，不重新发送。

`A2A_CONNECTOR_INSTANCE` 可隔离多实例（最长32字符的小写字母、数字、下划线或连字符）；每个实例有独立身份、进程、任务记录及动态端口。`A2A_CONNECTOR_CONFIG_DIR` 可指定私有状态目录，默认 `~/.config/a2a-connector/`。已有 settings 不匹配时不会覆盖，须先检查或使用另一实例。

## 云端模式

首次配置云端受控 Agent（与已有桌面实例使用不同 instance）：

```bash
# 此实例先按上文 auth enroll 兑换自己的控制台票据
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

新建会话先提交仅要求 `READY` 的初始化指令，取得 ACP 凭据并加载会话后，再用 ACP `session/prompt` 提交实际任务一次，避免创建接口和 ACP 重复执行同一条业务指令。初始化本身可能使用平台额度。ACP 通过认证 SSE + POST 双通道通信，按 initialize、session/load、session/prompt 顺序调用；旧历史不混入新轮次结果。只有当前 prompt 的最终响应或严格关联到当前提供方轮次的 `session/endTurn` 通知携带 `stopReason=end_turn` 才报告完成，拒绝/取消分别映射为 rejected/canceled，额度或轮次中断保持 input-required。提供方轮次 ID 必须来自实时回显且与原指令完全匹配的 user_message_chunk；其他轮次、历史通知和无关联结束事件均不完成当前任务。支持流式文本、产物增量更新及删除；返回产物正文或 `agent:///` 位置，不伪造媒体下载地址。

工具审批会返回 `TASK_STATE_INPUT_REQUIRED`，`task` / `adapter task` 的 `metadata.permission` 包含 request ID、工具说明及可选项。收到用户明确选择后，主控可回复：

```bash
rtk proxy workbuddy-a2a permission TARGET_AGENT_ID A2A_TASK_ID '"permission-1"' ACTUAL_OPTION_ID
rtk proxy workbuddy-a2a cancel TARGET_AGENT_ID A2A_TASK_ID
```

permission 的 request ID 参数为 JSON：字符串带双引号，数字保留数字类型；必须使用原请求提供的 option ID。不得为继续执行而自动批准。取消会向 ACP 发送 session/cancel，并等待真实 cancelled 结束响应，发送取消请求不等于任务已经停止。

创建/发送结果未知、ACP 断线或 runner 重启后，保留原 A2A 与云端 task ID，不自动重建或重发；需要用户在原云端会话核实。创建响应丢失时，任务元数据保留唯一 `cloudName=A2A-<A2A_TASK_ID>` 供查询平台任务列表。此类未核实任务会阻止新的受控轮次；不会仅凭会话 idle/completed 或历史文字推断当前轮次成功，也不宣称可跨连接恢复丢失的最终 RPC 响应。

用户检查原云端会话、确认不再执行后，可明确放弃这轮跟踪：`workbuddy-a2a release TARGET_AGENT_ID A2A_TASK_ID`。若创建响应丢失，追加通过 cloudName 找到的云端 task ID；驱动会验证名称匹配及云端已不活跃。该操作仅把未核实记录关闭为 rejected 并释放队列，**不报告执行成功，也不取消远端任务**。不自动调用 release 来绕过未解决状态。

ACP 地址仅信任官方 `acp.workbuddy.cn/sessions/<id>`、文档中的 `*.agentos-run.net/acp`，以及实际 Open API 返回的 `65225-<32位十六进制沙箱ID>.e2b.<区域>.sandbox.cloudstudio.club/acp`。仅允许 HTTPS，禁止查询参数、重定向及任意外部凭据目的地。ACP token 过期时，在发送业务 prompt 前通过原 task ID 获取新凭据并重建连接；已尝试发送的业务 prompt 不会自动重试。

新创建的会话在返回 ACP 凭据后可能持续显示 `working`，此时可进入 initialize/load；绑定会话和已有 context 仍要求平台空闲，避免与其他轮次重叠。网关请求使用数字 ID 和明确的 Accept 请求头，并兼容加载期间空 jsonrpc 版本的已知通知；RPC 响应仍严格校验。

失败回执通过 `metadata.failureStage`、`blockedReason`、`businessPromptAttempted` 和 `providerState` 区分创建、等待凭据、建连、加载和业务发送阶段，不暴露上游凭据。对明确未尝试发送业务指令的新建会话，主控可显式调用 `workbuddy-a2a resume TARGET_AGENT_ID A2A_TASK_ID`（A2A 方法 `ResumeCloudTask`），复用原 task/context/remoteTask ID。它核对云端会话名称并原子认领恢复；任何已有 promptRequestId、业务发送标记、未知创建结果或外部绑定会话均拒绝恢复。此命令需要与其他任务控制操作相同的目标 ACL，不会自动执行，也不代替用户审批。

对于业务指令已发送但结束回执丢失的自有新建会话，`workbuddy-a2a reconcile TARGET_AGENT_ID A2A_TASK_ID`（A2A 方法 `ReconcileCloudTask`）仅连接并回放原会话，不创建任务、不发送 prompt。必须唯一匹配创建时间之后的原始用户指令及提供方轮次 ID，再找到该轮次唯一的明确 endTurn，才更新终态；重复同文指令、错误轮次、没有结束信号或外部绑定会话均保持未核实。`providerCompletionSignal` 标明实时通知或只读回放核实的依据。

企业 Relay 从 `workbuddyNativeVersion=completion-recovery-v3` 开始开放上述两个 RPC：reconcile 需要 `task_read`，resume 同时需要 `task_read` 和 `invoke`，并校验原调用身份的任务归属；个人身份还需对应成员权限与机器授权的交集。旧版 Relay 缺少方法映射，补授权不能解锁。取消、审批回复、释放跟踪分别需要 `task_cancel`、`permission_respond`、`tracking_release`；管理员身份不会绕过授权或归属检查。释放还要求用户明确放弃跟踪、没有活动连接或恢复操作，并确认云端已停止活动。

原生 Go 接收端对只有 URI 的文件产物返回 `parts[].url` 和 `metadata.contentAvailability=reference_only`；实际内联正文才放在 `parts[].text`，标记为 `inline`。`agent:///...` 是提供方工作区引用，不是 Relay 下载地址；产物记录存在不能证明业务轮次已完成。

Relay 健康接口包含 `workbuddyArtifactVersion=download-v1` 或 `download-v2` 时，可以读取原任务的登记产物，不必取消或释放未决任务：

```bash
rtk proxy workbuddy-a2a artifact TARGET_AGENT_ID ORIGINAL_A2A_TASK_ID 'agent:///workspace/relay-doctor.mjs' --output ./relay-doctor.mjs
```

需要 `task_read`、原任务归属及客户端发现能力卡所需的 `discover`；不要求 `invoke`。CLI 调用 `GetArtifact({id,artifactId})`，校验文件大小和 SHA-256 后按原始字节保存，权限为 0600，已有文件不会覆盖。RPC/CLI 单文件上限 8 MiB；MCP 工具 `a2a_artifact({targetAgentId,taskId,artifactId})` 上限 512 KiB，文本文件直接返回正文。此功能当前适用于提供 `/acp` 沙箱端点的原生 Go 云端接收端；不支持的目标返回明确错误。下载成功不改变任务状态，也不代表业务轮次已完成。上游票据和签名地址只在服务端短暂使用，不返回客户端。

接收端重启后会自动对符合上述条件的原任务执行只读核实；断线后的未知结果也会每30秒重试核实。普通 `GetTask` 会触发后台检查，不需要接收端获得调用自身的 ACL，也不要求主控先调用 reconcile。核实必须恢复对应轮次的结果正文；只有平台 completed、旧的流式片段或缺失 endTurn，均不能报告成功。`metadata.recoveryState=pending/awaiting_evidence` 表示等待原会话证据，主控应继续查询原 task ID，不重新派发；核实成功后为 verified，普通 GetTask 返回恢复后的完整正文并释放串行队列。无法核实的记录仍阻止新任务，不自动 release。接收端停机或沙箱休眠时无法恢复，须先恢复接收进程。

恢复正文与确认终态分别处理：若已唯一匹配原提供方轮次并回放出正文，但 endTurn 缺失或冲突，GetTask 仍返回已恢复的内容，标明 `recoveryState=output_recovered`、`completionVerified=false`、`recoveryBlockedReason`（missing_end_turn / conflicting_end_turn / unconfirmed_stop_reason）。状态继续为 input-required，不把正文当作已验证完成的结果。`recoveryEndTurnCount` 区分没有结束事件和重复事件；相同提供方轮次、相同 stopReason 的重复通知按幂等证据处理，冲突的原因仍拒绝确认。

适配器也按官方协议读取原沙箱 `/api/session/artifacts?sessionId=<原云端ID>`，恢复断线期间漏掉的历史产物。返回数据必须属于原会话；产物正文和 agent:/// 位置可回传，签名 URL 和 task ticket 不写入任务记录。会话产物本身不证明原业务轮次完成，即使没有 endTurn 也可在 GetTask 的 artifacts 中查看，`artifactRecoveryState=recovered` 标明恢复来源。

## 开放平台 OAuth 与 Relay 配置

Buddy 应用登记回调 `https://dsh-relay.chuanbota.com/oauth/workbuddy/callback`。PC 模式申请 `user.localassistant.readable`、`user.localassistant.invokable`；云端模式申请 `user.task.readable`、`user.task.invokable`。Relay 服务端私有环境配置：

```text
WORKBUDDY_CLIENT_ID=<应用Client ID>
WORKBUDDY_CLIENT_SECRET=<应用密钥>
WORKBUDDY_TOKEN_KEY=<32字节随机数据的Base64编码>
WORKBUDDY_SCOPES=user.localassistant.readable user.localassistant.invokable
```

仅云端时，SCOPES 改为 `user.task.readable user.task.invokable`；同一获批 Agent 需要两种能力时配置四个权限并重新授权。接收身份统一从企业 MySQL 数据库读取，在控制台创建并授权；不使用配置中的单身份或身份清单。不同身份使用各自的账号和机器凭据，不能复制其他用户凭据。

密钥仅保存在服务端私有环境；加密密钥须跨重启保留。只有明确允许的接入身份可使用 OAuth，各身份只能读取认证后自身索引的应用令牌。部署及反向代理路径见 [Relay 说明](../../../a2a-relay/README.md#workbuddy-open-api-oauth-callback)。之后运行：

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

企业管理员在 `/console` 的**目标 Agent**「谁能访问」中选择当前 WorkBuddy Agent 为机器调用方，授予查看/调用/读取任务等所需动作，方向为「当前调用方 → 目标」。个人身份还需绑定成员的有效成员/用户组权限交集。核对 `targets` 的 callerAgentId 和准确目标 ID，不把同名 MCP Controller 当作同一身份：

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

`cli.json` 声明托管 Node.js22、非交互安装及 auth connect/connection status/auth logout。先用 auth enroll 兑换身份绑定票据；GUI auth connect 复用凭据与后台服务，并提供官方账号授权引导，不创建全局配对申请。connection status 只读检查实时隧道、账号和平台状态。

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
