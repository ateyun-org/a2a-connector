# A2A Connector 通用准备、接入与验证

适用于 [OpenClaw](openclaw.md)、[Hermes](hermes.md)、[DSH](dsh.md) 和 [WorkBuddy](workbuddy.md)。Relay 仅使用 MySQL 组织授权；所有身份和权限在 `/console` 管理。

## 安装前检查

1. 从控制台取得实际 Relay WSS URL、Agent ID 和身份绑定的一次性票据。不要自行生成 Agent ID，不要索取共享管理员 token。
2. 本机 A2A origin 必须可用，`/.well-known/agent-card.json` 返回非空 name，并提供支持文本 SendMessage/GetTask 的 A2A 接口。OpenClaw/Hermes 安装器先检测宿主原生 A2A，仅在缺少能力时安装兼容接收服务；DSH 有内置 adapter。WorkBuddy 内置 adapter 先兑换票据、再 setup。Relay 原生 WorkBuddy 接收端请直接使用[控制台托管接入](workbuddy-hosted.md)。
3. 使用 Node.js 22+。Relay 使用 `wss://.../connect`；`--allow-insecure` 仅用于本地测试。origin 不带 endpoint 路径或查询参数。若需要本机 Bearer token，通过私有环境 `A2A_LOCAL_TOKEN` 提供。
4. 复用现有凭据和状态路径。每个 Agent、实例只有一个 Connector；重启不重新兑换。不要把凭据或票据写入命令历史、日志、聊天、共享配置或 Git。

## 票据接入

企业所有者或管理员在「Agent 管理 → 接入 Agent → Connector」创建或选择身份并签发票据。签发即批准该身份接入，票据绑定企业和 Agent；用户组管理后续使用权限，不选择审批人。

通过私有进程环境提供 `A2A_PAIR_CODE`，将下列占位符替换为控制台信息：

```bash
rtk proxy sh scripts/install-connector.sh install --host HOST \
  --expect-agent-id AGENT_ID_FROM_CONSOLE \
  --relay wss://YOUR_RELAY/connect --local http://127.0.0.1:9900 \
  --expect-name 'ACTUAL_AGENT_CARD_NAME'
```

HOST 为 workbuddy、openclaw、hermes 或 dsh。安装器验证本机 Card，通过 `/register` 兑换一次、私密保存凭据并启动隧道。匹配的已有凭据直接复用；其他身份的状态拒绝覆盖。后台进程不会继承票据；完成后清除调用环境中的 `A2A_PAIR_CODE`。

同机多实例使用各自的 `--instance` 与 `--expect-name`。OpenClaw/Hermes/DSH 可用 `--state` 指定独立状态；安装器启动独立 Connector，不安装宿主插件或 adapter，不应与宿主受管理的 Connector 并发共用身份。WorkBuddy 使用其固定实例状态目录，`A2A_CONNECTOR_CONFIG_DIR` 可选择私有目录。

用相同 host/instance/state 执行 `status` 或 `stop`。再次 install 可不带票据复用凭据。`--local auto --port-start 9900` 按 exact Card name 扫描现有服务；不会改变外部服务端口，也不会把本机 token 发往未经确认的端口。

独立 CLI 首次接入：

```bash
rtk proxy node src/cli.js -relay wss://YOUR_RELAY/connect \
  -agent-id AGENT_ID_FROM_CONSOLE -state /private/path/agent.json -enroll-only
```

成功后清除票据环境变量，使用相同 state、relay 和实际 local origin 启动。`-auto-pair`、`-request-only`、`-pair-code` 已移除；启动缺少凭据直接报告 enrollment_required，没有全局配对申请和审批轮询。

## 凭据与恢复

凭据文件0600、目录0700。原子 `<state>.lock` 保存无密钥的进程身份；确认已退出的本机旧锁自动回收，跨主机/损坏/无法确认所有者的锁拒绝自动删除。进程出生标识识别 PID 复用。状态工具无需打印凭据。

兑换401、超时或响应丢失会停止，不能自动重复兑换或新建身份。先停下使用同一状态的进程，检查是否已有有效凭据/隧道和私有 `.state-*`。临时文件可能含完整凭据，不删除、贴出或覆盖现有文件。仅在确认身份匹配、目标状态不存在、没有并发写入后由管理员恢复。确认没有可用凭据后才在控制台签发新票据；兑换新票据会轮换旧凭据并断开旧隧道。

受管理进程退避重连，配置/凭据/兑换结果不明以78退出并停止自动重试；锁竞争用75。recentLogs 是历史诊断，当前入站健康以 running/tunnelOnline 为准。不要删除凭据来修复连接问题。

## 按顺序验证与排错

1. 检查实际 Node 路径及22+版本、宿主插件加载、本机 Card/RPC 和本机认证。
2. 核对已保存 Agent ID 与控制台完全一致；相同名称不能证明相同身份。
3. 用 `a2a_connector_status` 或 `node src/cli.js -state /private/path/agent.json -status` 检查 running、paired、tunnelOnline 和最近错误；凭据存在不代表隧道在线。控制台刷新连接快照。WorkBuddy 托管接收端就绪不代表电脑在线。
4. 在**目标 Agent** 的「谁能访问」中选实际调用方并授予需要的动作，方向为调用方 → 目标。个人调用方还需绑定成员的有效成员/用户组权限交集；凭据 call scope、Agent 启用/canCall/canReceive 也须满足。
5. 只有用户授权真实派单时才发任务。只读检查不自动创建测试任务。报告实际 caller/target ID、操作和结果，不凭卡片200推断所有调用权限。

## 通道与任务边界

Relay 只转发已知 A2A 操作并检查动作、任务和上下文归属。ListTasks 使用 task_read，只返回当前调用方的任务，总数和分页均在归属过滤后计算；GetTask 需要 task_read 和当前调用方创建的 taskId。详细格式和收据恢复见[Relay HTTP 协议](../relay-http.md)。保留稳定 messageId、调用方/目标 ID、Relay request ID、taskId/contextId；超时不重新派发，先读原收据或任务，404也不证明未执行。

将本机 origin 绑定 loopback 并保护 Card/RPC。Connector 默认正文上限16MiB；DSH内置 adapter/隧道统一1MiB。当前缓冲整个正文，不支持SSE转发。普通断线重连复用凭据，不重复接入。
