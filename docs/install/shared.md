# A2A Connector 通用准备、配对与验证

适用于 [OpenClaw](openclaw.md)、[Hermes](hermes.md)、[DSH](dsh.md) 和 [WorkBuddy](workbuddy.md)。先完成本页的检查，再执行对应宿主的安装步骤。

## 需要确认的参数

开始前从现有配置或用户处确认：

- **Relay URL**：`wss://dsh-relay.chuanbota.com/connect`。配对审批页是 `https://dsh-relay.chuanbota.com/pair`。
- **本机 A2A origin**：Agent Card 和 A2A HTTP 服务所在的 origin，例如 `http://127.0.0.1:9900`。不要附加路径、查询参数或尾部端点路径。
- **宿主类型**：OpenClaw、Hermes、DSH 或 WorkBuddy。先用已安装的宿主，不要同时安装多个插件。
- **本机认证**：若本机 Agent Card/A2A 接口要求 Bearer token，确认 token 已存在于宿主进程环境的哪个变量中；不要把 token 写入命令历史、配置明文或对话。
- **Agent ID**：通常留空。Connector 首次配对时会根据 Agent Card 名称生成 ID，并保存在状态文件里；单纯重启不需要固定 ID。仅在部署系统要预先引用固定 ID 或迁移身份时配置，具体入口见所选宿主文档。复用已有 ID 重新配对会轮换它的凭据。

不要猜 Relay 地址或本机端口。缺少必需参数时，只向用户询问缺少的值，先不要申请配对。

## 安装前检查

1. 确认目标 Agent 已启动，并从 Connector 所在机器访问本机 origin 下的 `/.well-known/agent-card.json`。HTTP 状态应为 200，响应 JSON 应包含非空 `name`。`name` 同时用于审批页显示和自动生成 Agent ID；同机多实例应使用可区分的名称。origin 还须提供 `POST /rpc` A2A v1.0 JSON-RPC 2.0 接口（`SendMessage`、`GetTask`、`CancelTask`、`ListTasks`），否则即使隧道在线也无法完成任务。若两个 Agent 自带的 A2A 服务都试图监听 9900，必须先在服务的启动配置中为它们指定不同端口或启用该服务自身的动态绑定；Connector 只连接现有端口，不负责启动或改变该服务。
2. 确认本机 Agent Card 中的 A2A 接口地址确实可由 Connector 进程访问。若 Agent 还没有本机 A2A HTTP endpoint，先按宿主文档配置 adapter；完成后重新检查，再配对。
3. 确认 Relay URL 使用 `wss://` 且路径为 `/connect`。`allowInsecure` / `-allow-insecure` 只允许到 Relay 使用 `ws://`，不会改变本机 origin 的 HTTP 配置；生产环境不要启用。
4. 优先复用已安装的 Connector 和现有配对身份。不要为了重试而重复配对；批准已有 Agent ID 会轮换该 Agent 的凭据。
5. 只安装与当前宿主对应的插件目录。`vendor/connector` 是随插件分发的 Connector 客户端副本，不要删掉或只拷贝入口文件。各宿主的依赖安装方法见对应文档。
6. 确认实际运行 Connector 的 Node.js 为 22 或更新版本，包括后台服务的进程环境。

## 配对与授权边界

配对分为五步；审批页出现 Agent **离线记录**，并不意味着本机已收到凭据或隧道已连接。

| 阶段 | 可核对的现象 | 下一步 |
| --- | --- | --- |
| 申请 | `POST /pairing/requests` 返回 requestId、Agent ID、六位确认码；本机写 `.pending` | 管理员核对并批准 |
| 批准 | Relay 建立/更新 Agent 记录，页面可能显示离线 | Connector 通过 `POST /pairing/status` 获取兑换码 |
| 兑换 | Connector 以 `pair_` 码请求 `POST /register`，成功返回 Agent 专属 token | 将凭据写入私有状态文件 |
| 落盘 | 凭据状态文件存在，权限 `0600`；`.pending` 清理 | 建立 WSS 隧道 |
| 在线 | Relay 显示 Agent 在线，并有到 Relay 的连接 | 再测试实际 A2A 请求 |

| 代码 | 用途 | 谁应接触 |
| --- | --- | --- |
| 六位 `confirmationCode`，如 `0E1C5C` | 审批页与本机显示的信息核对；不是凭据 | 用户和 Relay 管理员 |
| `pair_` + 48 位十六进制码 | 从 `/pairing/status` 的 approved 响应取得，供 Connector **一次性**兑换 token | 仅 Connector；不要发到聊天或交给管理员 |

Connector 首次启动后会显示审批 URL、Agent ID 和六位确认码。把这三项交给用户/Relay 管理员；管理员应以 **Agent ID + 确认码** 为准，不能只看显示名（同名 Agent 可有多个）。**不要索取 Relay 管理员 token，也不要代替管理员批准。**等待审批的请求保存十分钟；批准后兑换码同样有独立的十分钟有效期。普通自动流程会轮询、兑换、写入凭据并连接，用户无需手动取得 `pair_` 码。

**同一状态文件只允许一个 Connector 进程轮询和兑换。**CLI 会将状态路径解析为规范绝对路径，再原子创建 `<state>.lock` 目录；第二个运行者会在网络操作前以 `state_locked` 退出。锁内 `owner.json` 保存 PID、主机名、进程出生标识、启动时间和实例 ID，不含凭据。正常退出自动释放；启动时会自动回收已确认进程退出的本机旧锁。新版锁还通过进程出生标识识别 PID 复用；跨主机、损坏、无所有者或无法确认身份的锁仍拒绝自动回收。恢复通过独占的回收锁和原子隔离避免并发启动误删新实例的锁，配对凭据保留。`-request-only` 可只读查看已有凭据/申请；创建新申请或兑换仍需持锁。旧版 CLI 没有此保护，升级时先停止旧进程。凭据文件属于敏感数据，不能打印、复制到不安全位置或提交。正常等待和断线重连时保留状态文件；只有确认进入下述故障恢复分支、且已停止所有使用该状态文件的进程后，才归档失效 `.pending`。

DSH、OpenClaw 的受管理 Connector 与 Hermes runner 内的 CLI 在异常退出后按 1、2、4 秒逐步退避重启，最长间隔 30 秒；主动停止会取消重启。配对结果不确定、配对冲突或配置错误以退出码 78 停止自动重启，防止重复兑换一次性配对码；锁竞争使用退出码 75。DSH、OpenClaw 状态工具的 `recentLogs` 是诊断历史，`logsAreHistorical` 会明确标记，`logRun` 给出运行 ID、PID、起止时间及最后日志时间，每次启动会清空上一轮日志；`restartScheduled` 表示正在等待重启。当前本机入站状态以 `running`、`tunnelOnline` 为准，远端状态另查 `a2a_agents`。

### 兑换失败、重复申请与安全恢复

| 现象 | 含义与处理 |
| --- | --- |
| `401` / `invalid_pairing_code` | 兑换码无效、已过期或已被另一个进程消耗；Relay 不区分这些原因。先检查是否已有成功的凭据/隧道，勿直接再兑换同一码。当前自动 CLI 会停止并保留 `.pending`，供安全恢复。 |
| `state_locked` | 同一规范状态路径已有运行/兑换者，或锁的所有权无法安全确认。已确认失效的本机锁会在启动时自动恢复；其余情况检查 `<state>.lock/owner.json` 和实际进程，确认停止后才移除遗留锁；不要重配对。 |
| `409` / `pairing_already_pending` | Relay 已有同 Agent ID 的待审批请求；当前自动 CLI 会停止并提示检查现有请求与进程，不会无限重试。 |
| 审批页有离线记录 | 批准只创建/更新记录；还要完成兑换、落盘和连接。按下文检查本机凭据是否存在、是否有连接。 |

恢复顺序：

1. 停止使用**同一状态路径**的全部 Connector 进程；先执行 `node src/cli.js -state /absolute/path/to/state.json -status`（插件包可使用 `vendor/connector/cli.js`），核对状态锁中的 PID；再用 `pgrep -fl '^a2a-[0-9a-f]{8}-'` 核对当前 CLI。旧版未改名进程还应按完整 argv 检查。只结束已核实路径和命令行的进程。不要在旧进程仍可能写文件时移动状态。
2. 先看状态文件**是否存在及权限**，不要输出正文。若凭据文件已存在，优先用原有身份启动单个 Connector 并验证连接，不要重新配对。若兑换返回成功后落盘被中断，状态目录可能留下 `.state-*` 临时文件；它可能包含完整 token。不要删除或贴出内容。只有在确认它包含完整 `agentId` 与 `token`、其身份匹配本次配对、目标凭据文件不存在且没有并发进程时，才在私有目录内以 `0600` 权限将它转正为目标凭据文件；否则保留供授权管理员排查。
3. 若确认没有可用凭据，且 `.pending` 指向已消耗/失效的请求，**先将它移到同一私有目录的备份名**（保留权限），再启动**一个** Connector 申请新请求。无固定 `-agent-id` 时会生成新 ID；若必须沿用旧 ID，先确认 Relay 没有该 ID 的活跃待审批请求，且重新批准会轮换旧凭据。当前自动 CLI 在进程内可能持续复用旧 ID；停止并重新启动后再核对实际显示的 Agent ID/确认码。不要再次批准旧请求。
4. 管理员只批准新的 **Agent ID + 六位确认码** 组合。确认新连接在线后，按管理员流程清理遗留的离线记录；不要将页面上同名记录当成同一身份。

不要将 `.state-*` 直接覆盖已有凭据；文件名不能证明其内容属于哪次申请。原生 CLI 的 `-pair-code` 或环境变量 `A2A_PAIR_CODE` 配合 `-enroll-only` 可在已有 `pair_` 码、**确认没有另一个兑换者**时执行一次确定性兑换；成功后再单独启动隧道。它不会等待审批或自动重试，六位确认码不能用于此参数。兑换码同样是敏感的一次性凭据，避免把它写进命令历史。各宿主的状态路径与操作命令见对应文档。

## 按顺序验证与排错

按依赖顺序检查，前一项未通过时先修复再继续：

1. **运行时**：确认 Connector 实际使用的 Node.js 为 22+，包括服务管理器的进程环境。
2. **本机 Agent**：从 Connector 主机请求 `<local origin>/.well-known/agent-card.json`，确认返回 200 且 JSON 有非空 `name`；再核对本机认证变量可由该进程读取。
3. **宿主加载**：确认所选宿主插件已启用，且其配对工具或 CLI 命令可调用；具体命令见对应宿主文档。
4. **配对申请**：取得当前请求的 URL、Agent ID、六位确认码；过期后检查或创建新请求，不要在正常等待时删除状态文件。
5. **批准与连线**：管理员核对 Agent ID 和确认码并批准后，核对本机已保存凭据。`status: paired` 或 `Logged in` 不能单独证明 Relay 连接仍活跃。先用 `a2a_connector_status`（DSH/OpenClaw）或 `node src/cli.js -state /absolute/path/to/state.json -status` 查看 `running`、`tunnelOnline`、最近连接时间与错误，再用 `pgrep -fl '^a2a-[0-9a-f]{8}-'` 查看当前 CLI；进程名为 `a2a-<sha256(规范状态路径)[0:8]>-<文件名标签>`，改名后不能靠匹配 `cli.js` 找到它。锁中的 PID 和路径比进程名更准确；`ps -p <PID> -o pid=,args=` 在某些沙箱对活进程可能返回空，不要单凭它判断。用 `lsof -nP -a -p <PID> -iTCP -sTCP:ESTABLISHED` 确认该进程有到**预期 Relay 地址**的连接，在审批页确认对应 Agent 在线，最后发一个授权的实际 A2A 请求验证转发。连接问题先检查 WSS 地址、本机 origin、认证变量和 Node 路径；不要直接重配对。

## 通道边界

本 Connector 接收 Relay 转发到本机 A2A origin 的入站流量。获授权的调用者可经 Relay 对该 origin 发送 `GET`、`POST`、`PUT`、`DELETE`、`PATCH` 请求及任意路径；仅安装 Connector 不会限制 origin 的路由。把 origin 限定在 `127.0.0.1`，并由本机 A2A 服务执行身份、方法和路径检查。若本机接口启用 Bearer 认证，使用足够长的随机 token 并通过进程环境传给 Connector。Connector 默认请求/响应正文上限为 16 MiB；`-max-request-body <bytes>` 可缩小入站请求限额。DSH 内置 adapter 与其隧道默认统一为 1 MiB（`maxRequestBodyBytes`），当前缓冲整个正文，不支持 SSE 流式传输；普通断线会自动重连。若主机设置了 HTTP 代理，仍需从 Connector 所在进程环境实测本机 `127.0.0.1` origin 可达；当前 Connector 没有显式的代理或 `NO_PROXY` 配置逻辑。

## 完成检查

按上述 1 到 5 的顺序完成检查。向用户报告当前状态是“等待管理员批准”还是“已配对并运行”，不要展示任何 token。
