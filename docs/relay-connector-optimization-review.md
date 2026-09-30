# Relay / Connector 优化核对与落地

核对日期：2026-09-30。依据是 `/Users/simons/test-dsh/relay-connector-optimizations.md` 与本工作区的 Relay/Connector 源码。原文的远端实测作为输入；这里新增的验证使用本地 HTTP/WSS 与测试 Redis，不代表线上已升级。

## 判断与范围

多数故障描述合理，优先修复“未知派发结果无法追踪、内联正文丢失、同路径并发兑换、隧道不可见”。以下结论需调整：

- Relay 9 分钟 < 客户端 10 分钟是正确顺序。504 表示 Relay 结束这次 HTTP 等待，不等于调用方自己的 HTTP 还在等；可能继续运行的是远端执行。关键是保留派发句柄与迟到响应。反代应更长，例如 11 分钟。
- ListTasks 空结果不能证明“未执行”：分页、history 缺失、任务过期和远端不支持都会让证据缺失。新工具对此保持 unknown，不允许自动新发。
- 每次生成新 messageId 表示新派发。幂等只能复用同一派发的稳定键，不按正文合并不同任务。同键不同内容需要冲突错误。
- `/agents` 不向 Connector 暴露管理员库存是合理边界。新增的是“当前身份可调用的目标”，不是开放所有 Agent。
- R5 已有 `invalid_pairing_code`、`pairing_already_pending` 等稳定码；过期/已消费兑换码共用一类错误，不为细分原因增加兑换重试。
- R6 的机器可读管理接口已经存在，见 `/admin/pairing/agents` 和 `/admin/pairing/requests`。独立只读权限作用域尚未实现。
- 文档原 `pgrep -af 'vendor/connector/cli.js'` 确实不适合已改名的进程。应以规范状态路径锁中的 PID、健康文件和锚定进程名共同核对。新的正则使用扩展语法 `{8}`，不是原文示例里的 `\{8\}`。

## 逐项处理

| ID | 处理 | 实现或保留条件 |
| --- | --- | --- |
| R1 | 已实现 | 预分配 requestId、Redis 派发日志、504 元数据、鉴权 GET `/relay/requests/{id}`；收集迟到 Task/Message 正文 |
| R2 | 已实现 | Lua 原子预占；caller + target + endpoint + 稳定键；请求指纹校验；复用同 task、适配当前 RPC id；默认 24h 保留 |
| R3 | 调整并落地 | 保留 A2A 响应协议，区分 HTTP 等待与后台收集；启动校验 timeout < processingTimeout < retention；文档写明 9/10/11 分钟。跨节点配置仍需部署者核对 |
| R4 | 已实现 | 调用方 GET `/pairing/targets`，只返回授权注册目标及隧道快照；DSH 启动诊断与 a2a_agents 刷新 |
| R5 | 已实现关联信息 | 响应 requestId/timestamp/target，保留现有稳定兑换错误码；不自动重复兑换未知结果的一次性码 |
| R6 | 原接口已存在 | 文档补准确 API；独立只读管理 token 需另定义作用域与管理员凭据迁移，暂保留原管理鉴权 |
| R7 | 部分落实 | 修复响应队列静默丢帧与 request.start 错误变量遮蔽；真正分块 HTTP/SSE 仍需双方协议、取消与背压设计 |
| C1 | 已实现 | 发前持久化；未知结果结构化返回；a2a_reconcile 查询 Relay 或按 messageId 匹配 history，绝不因空列表自动重发 |
| C2 | 已实现 | 内联终态 Task 用既有 responseParts 提取正文，状态/文本 artifact 去重；单次发送即可取得输出 |
| C3 | 已实现 | 规范路径原子目录锁覆盖运行、申请与兑换；重复 CLI 网络前退出；崩溃锁人工核实后清理 |
| C4 | 已实现 | DSH/OpenClaw 子进程输出进入有上限的内存日志；a2a_connector_status；CLI token-free health + PID/实例/新鲜度判断；available 明确为出站 Card |
| C5 | 已实现 | 派发及 provider 等待共用任务预算；默认 30min；到期有界、尽力取消，不声称远端保证终止 |
| C6 | 部分实现 | 指数退避与抖动，上限 30s；push 需要可鉴权回调地址、订阅生命周期和事件去重，单看 capability 无法直接接通 |
| C7 | 已实现本机只读历史 | 显式查询旧 session；保留续聊/取消所有权。写入时清理终态 30d TTL、限制4096条，未知/运行记录不丢弃；共享范围为同一本机profile/store |
| C8 | 已实现 | 429 + Retry-After 本地冷却、停止当前轮询；不自动重投任务 |
| C9 | 已实现 Connector 入口 | CLI 可配置1–16MiB请求上限；DSH adapter/隧道默认同为1MiB；超额块不进入本机origin。Relay全局仍16MiB，按origin提前拒绝需限额协商协议 |
| C10 | 已实现 | 数字state保持兼容，增加stateName；单一去重response，artifact只附元数据，避免正文重复 |
| C11 | 维持现有文本边界 | 本地DSH driver当前返回文本；多模态/结构化artifact需定义driver输出和宿主支持，不能只在HTTP层宣称透传 |
| C12 | 部分保护/待专项 | 启动函数已有进程内幂等保护，新增跨CLI状态锁防双兑换；HMR跨实例adapter/provider复用需真实Cordis dispose顺序回归，尚不宣称无缝复用 |
| D1 | 已修文档与安装器 | 锁PID与-status优先；进程名锚定查询；安装器按相同规范路径计算指纹 |
| D2 | 已修 | 文档明确conversations → reconcile → found/unknown；首次未返回ID也有发前记录 |
| D3 | 已修 | 明确HTTP超时顺序、后台收集/保留、总等待与取消边界 |

## 回归与实际边界

新增测试覆盖内联输出、504后迟到完成、同键在途/完成重放、RPC id重写、不同正文冲突、跨调用方隔离与撤销授权、并发Redis原子预占、新Store保留和TTL一起过期、发前本地记录、跨session只读对账、总等待取消、429停止轮询、同路径第二CLI退出、强杀后的隧道离线、缩小正文限额不访问origin。原有主套件、DSH套件和Go race测试一起验证。

Redis必须保留请求日志/去重键。Relay进程重启后预占还在，但丢失的WebSocket响应无法凭空恢复；保留窗口外同键不保证去重，故未知任务仍须外部核实。`forwarded:true`只表示完整请求写入隧道，不能证明目标执行；false也不能证明没执行。新API依赖反代路由 `/relay/requests/`、`/pairing/targets`；旧Relay不能凭客户端升级获得完整对账。CLI锁不能约束未升级的旧CLI。

源码与四个vendor副本已同步；本次没有更新 `/Users/simons/test-dsh` 的已安装插件，没有重启宿主或部署线上Relay。上线应先核对反代路由与Redis保留，再升级Relay和Connector，并用真实授权目标重复上述关键验收。

本地验收结果：Connector主套件37/37、DSH套件22/22、Relay及关联服务Go测试12项、Hermes Python测试8项通过；`go test -race ./...`通过，两个仓库的`git diff --check`均通过。
