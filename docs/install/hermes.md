# Hermes 安装 A2A Connector

开始前阅读[通用接入与验证](shared.md)。Connector 优先使用当前 Hermes 自带的官方 A2A；只有确认没有官方模块时才安装和启动兼容服务。官方模块未启用、不可达或认证失败，都不会触发兼容模式。

企业 Relay 使用[企业票据接入](shared.md#票据接入)，不要调用旧配对工具继续等待审批。独立企业安装器只运行 Connector，不安装宿主插件或 skill；需要本页的插件管理和调用 skill 时，还应在实际 Hermes profile 安装/升级插件并加载它，避免另起同状态的第二个 Connector。下文 pair 工具使用同一控制台票据流程；远程调用说明见「日常管理与排错」。

## 安装前检查

使用实际 Hermes Python、实际 home/profile 和 Node.js 22+。Windows 使用原生路径，例如 `D:/Program Files/nodejs/node.exe`；从当前机器检测实际安装位置，不要假定 C 盘，也不要给原生 Python 传 Git Bash 的 `/c/...` 路径。参数列表直接交给 subprocess，带空格的路径无需额外 shell 转义。

在仓库根目录先执行只读预检，下面的路径替换为实际值：

```bash
python scripts/install-hermes.py --check --home /actual/hermes/home \
  --hermes-python /actual/hermes/python --node /actual/node \
  --relay wss://dsh-relay.chuanbota.com/connect
```

默认也能从 PATH 检测 Node。`--check` 验证 Python 的 Hermes 源码根目录、Node 路径/版本和 A2A 能力，不写配置、不申请配对、不要求官方 A2A 已经启动。Hermes 从源码启动时加 `--hermes-root /actual/hermes-agent`。命名 profile 的 `--home` 指向实际 profile home；multiplex Gateway 使用启动共享 Gateway 的 home。

升级已有安装时加 `--upgrade`，并指定旧实例实际的 `--state`；安装器请求受管理的 runner 停止，随后将旧插件原子备份到 home 下的 `a2a-connector.backup-*`（在 `plugins/` 外）再替换。原凭据保留，备份路径会输出。已确认进程退出的本机遗留锁会自动回收；旧版/孤立的存活进程或无法确认所有权的锁仍拒绝替换，不猜测 PID、不强杀。常规安装仍拒绝覆盖已有目录；插件目录中只能保留一个 `name: a2a-connector`。

**从 Windows 0.2.4 升级**：旧版 Python 的进程探测/停止有兼容缺陷。先在 Gateway 外部根据 `.a2a-runtime.json`、两个 `.lock/owner.json` 和实际进程命令行核对旧 runner/CLI，再停止已确认的进程树。不要调用旧版插件的 start/stop 来清理，也不要按 `node` 名称批量终止无关进程。确认对应进程都已退出后才处理遗留锁；保留状态凭据。新版本统一通过 runner 的受管理停止流程退出子进程并清理锁。

## 安装与一次性加载

1. 执行安装脚本，保存非敏感参数和实际运行时路径：

   ```bash
   python scripts/install-hermes.py --home /actual/hermes/home \
     --hermes-python /actual/hermes/python --node /actual/node \
     --relay wss://dsh-relay.chuanbota.com/connect \
     --state /actual/private/a2a-connector/hermes.json
   ```

   `--node` 可省略，此时从 PATH 查找并验证。`--state` 可省略，插件默认 `~/.config/a2a-connector/hermes.json`；多个独立实例使用不同状态路径。

   安装器只检查模块能力来决定复制哪些文件，运行时才检查服务是否健康。原生/已有模式不复制 `adapter-server.js` 和 `agent-driver.js`；兼容模式才复制。安装器不安装或升级 Hermes，不改宿主配置、凭据或 `.env`，`ws` 已随包提供。

   安装目录中的 `host-runtime.json` 保存实际 Node、Hermes Python 和源码/home 提示，直接运行 runner 时也能找到正确 Python。`connector-config.json` 保存非敏感参数，插件每次操作会重新读取；其中配置优先于同名进程环境变量。允许的键为 `A2A_RELAY_URL`、`A2A_LOCAL_URL`、`A2A_NODE_BINARY`、`A2A_CONNECTOR_STATE`、`A2A_AGENT_ID`。token 不写入该文件。

2. 在目标 profile 启用工具/Hook 插件：

   ```bash
   hermes plugins enable a2a-connector
   ```

   这是普通工具/Hook 插件，不是 Gateway platform。命名独立 profile 使用 `hermes -p coder plugins enable a2a-connector`。multiplex Gateway 使用共享 Gateway 的启动 profile。

3. 检测结果为 native 时，启用宿主官方 A2A：

   ```yaml
   gateway:
     platforms:
       a2a:
         enabled: true
         extra:
           port: 9900
   ```

   配置保留其他已有段。官方端口优先读 `A2A_PORT`，否则读取当前 profile 的 `gateway.platforms.a2a.extra.port`，默认 9900。官方服务的 localhost 模式可通过本机 Connector 转发，不要求开放公网端口。见[官方 A2A 文档](https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/a2a/README.md)。

   若官方服务需要认证，在该 Hermes home/profile 的 `.env` 配置 `A2A_LOCAL_TOKEN`，也可沿用 `A2A_BEARER_TOKEN` 或 `A2A_PEER_TOKENS` 中名为 `connector` 的 token。不随意使用其他 peer 的凭据。保持文件私有，不把真实 token 写进命令参数或聊天。进程环境配置方式仍兼容，`A2A_HERMES_PYTHON` 由插件自动设置为当前 `sys.executable`。

4. 完成插件注册、官方 platform 和宿主环境配置后，**从 Gateway 外部的独立终端/SSH 加载一次**：

   ```bash
   hermes gateway restart
   hermes gateway status
   ```

   独立命名 profile 的两个命令使用同一 `-p`；multiplex 重启共享 Gateway。保留完整输出，检查新 Gateway 状态。不要让正在服务当前聊天的 Agent 自己执行 Gateway restart，也不要用原始 systemctl/nohup/后台 `&` 绕过内部保护。不要直接修改 Hermes 生成的主 systemd unit；特殊服务环境使用 drop-in，参考[官方 Gateway 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)。

5. 在目标 Agent 执行 `/a2a_connector doctor`，然后调用 `a2a_connector_pair` 或 `/a2a_connector pair`。先由管理员在企业控制台创建/选择身份并签发票据，按通用说明私密兑换到当前 state；随后启动受管理的 worker。pair 未给票据时只检查凭据，不申请审批。

6. 使用 `a2a_connector_status` 或 `/a2a_connector status` 验证 `running`、`paired` 和 `tunnelOnline`。这三个状态分别表示 runner 存活、凭据已保存、CLI 的近期连接健康信息确认隧道在线。最后按[通用验证](shared.md#按顺序验证与排错)执行实际 A2A 请求。

## 日常管理与排错

需要 Hermes 交付文件时，直接套用[文件交付指令模板](../relay-http.md#hermes-file-delivery-request-templates)：首次派单明确要求用接收端自己的 Connector CLI 上传到原业务 task ID；已有文件只补传，不重做业务。模板也说明 task ID 尚不可得时的处理和主控的字节校验步骤。

插件随包提供远程调用 skill，安装和 `--upgrade` 都会复制 `skills/relay-calling/`。新版 Hermes 加载插件时通过 `ctx.register_skill` 注册；远程派单或排查 Relay 前，先调用 `skill_view("a2a-connector:relay-calling")`，按其中链接读取 HTTP 请求、权限和收据恢复说明。`a2a_connector_status` 的工具说明也会提示加载它。旧 Hermes 没有注册 API 时，插件仍可管理 Connector，并提示直接读取安装目录的 `skills/relay-calling/SKILL.md`。插件 skill 是显式加载的；不能把安装成功当作当前会话已读到新说明。见 [Hermes 官方插件 skill 机制](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/index.md#bundle-skills)。

该 skill 区分企业 `/console` 和旧版配对流程，给出 caller → target 的授权方向，以及精确的 `ROLE_USER`、`params.message`、`messageId` 和文本 parts。ListTasks 按调用方隔离，使用 task_read 及 Relay 分页令牌；GetTask 需要本身份的任务归属；企业仍支持带幂等键的请求收据。不要因这些状态反复重配对或要求管理员重复授权。Hermes 内置 A2A 工具未注册时可使用 skill 中的 HTTPS 协议，不擅自修改宿主配置启用另一套身份。

| 命令 | 行为 |
| --- | --- |
| `/a2a_connector doctor` | 核对当前环境里的 Node/Python、源码能力、实际 state/PID/log 路径和运行状态；不申请审批 |
| `/a2a_connector status` / `a2a_connector_status` | 只读运行、配对与隧道健康；不显示 token |
| `/a2a_connector start` | 启动或复用同一状态文件的 runner；也识别手动启动的新版本 runner |
| `/a2a_connector pair` | 检查已有凭据并启动 worker；显式 code 才兑换控制台票据，不自动申请审批 |
| `/a2a_connector stop` | 请求 runner 清理自己的 CLI、兼容服务和锁；保留凭据 |

插件启动 Hook 是 `on_session_start`，只有开始新 session 才触发；同一会话再发一句消息不等于新 session。不依赖 Hook 时可以直接调用 start/pair。普通 CLI 子命令 `hermes a2a_connector ...` 不存在。

从外部终端也可使用实际 Hermes Python 执行安装目录中的 `__init__.py status|doctor|start|stop|pair`。独立进程不自动读取宿主 `.env`，认证等环境应由有效的宿主环境提供；状态检查不需要本机服务 token。该入口管理 Connector，不重启 Gateway。

修改 `connector-config.json` 的 Node/Relay/local 等非敏感参数后，只需停止并重新启动 Connector，Gateway 内每次操作都会读取新值。修改宿主 `.env`、插件注册或官方 platform 时，才需要从外部重新加载 Gateway。切换状态路径前先停止原路径对应的 Connector，避免留下旧实例。

`WinError 2` 优先检查报错调用和实际可执行路径；没有匹配到日志不能证明插件没有 import。插件自检失败仍注册诊断工具。独立 Bash/Python 测试成功不能证明 Gateway 使用了相同的 home、Python、环境或安装副本。

stdout/stderr 都保存在 state 路径替换扩展名后的 `.stderr.log`，例如 `hermes.json` 对应 `hermes.stderr.log`；PID 镜像为 `hermes.pid`，不是 `hermes.json.pid`。Windows 使用当前用户和 SYSTEM 的受保护 DACL，POSIX 使用目录 0700/文件 0600。日志包含运行诊断，保持私有，不直接整份贴入聊天；日志追加写入，按主机策略轮转。

运行身份由规范状态路径的 `.hermes-runner.lock/owner.json` 和 `.a2a-runtime.json` 管理，CLI 使用独立 `.lock`。`.pid` 是辅助文件，不是存活判断依据。runner 的 stop 请求绑定实例 ID，通过 IPC 让 CLI 退出；不使用 Python `os.kill(pid, 0)` 探测 Windows 进程。启动或受管理停止时会自动恢复已确认失效的本机旧锁，新版锁通过进程出生标识识别 PID 复用。跨主机、损坏或身份无法确认的锁仍需人工核实。CLI 异常退出后由同一 runner 退避重启；配置/配对错误停止自动重试。不要删除凭据来解决连接问题。自动启动仍由 Hermes 的 `on_session_start` 触发；操作系统开机自启需要宿主 Gateway 自身的常驻配置。

`.a2a-runtime.json` 可能包含兼容服务临时 token，status 不输出它。runtime 文件存在、进程存活、凭据落盘都不能单独证明 WSS 已连通。短暂断线由 worker 自动处理，不需要 Gateway 重启。

## 原生 A2A 的五分钟长任务超时

原生 Hermes 返回 `[agent did not reply in time]` 时，应先检查它的 `A2A_REPLY_TIMEOUT`，默认 300 秒。某些版本的 `SendMessage` 即使收到 `configuration.returnImmediately: true` 仍同步等待最终回复，到期就结束 A2A 任务并丢掉 pending 回调。单独延长 Relay 或 DSH 的超时不能修复这个接收端行为。先保留并核对原任务与实际执行结果；不要把等待超时当作未执行的证明，也不要自动新建一份任务。

仓库提供 `scripts/patch-hermes-a2a-async.py`，修复已识别的**根路径 / local profile 原生接收端**。它沿用原生任务、权限检查、回复脱敏及 input-required 处理；立即返回同一任务的 `WORKING` 回执，在后台回复到达后通过原生 finalizer 写入结果，主控用 `GetTask` 继续查询。原有同步请求保持同步。转发到其他本机 profile 的 `_forward_to_profile` 不属于此补丁范围。

已部署版本的精确源码差异和基线校验值保存在 [patches/](../../patches/README.md)，与修复脚本生成的结果一致。

在目标 Hermes 主机的 Connector 仓库目录中，用该 Hermes **实际使用的 Python** 和源码目录执行：

```bash
rtk proxy /actual/hermes/python scripts/patch-hermes-a2a-async.py --hermes-root /actual/hermes-agent --check
rtk proxy /actual/hermes/python scripts/patch-hermes-a2a-async.py --hermes-root /actual/hermes-agent --apply
```

默认只检查。`--apply` 只修复已识别的原生回执处理和待处理回复登记，先创建带内容摘要的原文件备份，再原子写入；重复执行返回 `already_patched`。后台结果保留完成该回复的实际 profile 上下文，包括回复早于回调注册的情况。接口结构、防孤儿任务机制或宿主的上下文线程工具不匹配时拒绝覆盖，需先核对/升级实际 Hermes 版本。它不修改 `.env`、Connector 凭据或 Gateway 配置，也不自动重启或补发任务。升级 Hermes 后需重新检查，避免源码更新覆盖补丁。

此修复需要按上文流程从 Gateway 外部重新加载。**原生任务仍在内存中，重启前应先处理已有未决任务**；本补丁不提供跨重启恢复，也不能找回旧版本已经丢弃的最终回复。回退时还原输出中的 `backup` 文件，再从外部重新加载。更新 Relay 或仅重新安装 Connector 不会自动应用此原生源码补丁。

验证下一次明确授权的任务是否立即返回 `taskId/contextId` 和 `WORKING`，随后使用同一调用方查询同一任务，确认超过原等待窗口后的结果仍可取得。`INPUT_REQUIRED` 需保留给人工决定，不视为完成或自动继续。

本地回归入口：

```bash
rtk proxy python3 -m unittest discover -s test -p test_hermes_native_async.py -v
rtk proxy /actual/hermes/python test/hermes-native-reference.py --hermes-root /actual/hermes-agent
```

第二条使用外部官方源码的 adapter、protocol、security 和脱敏模块，在临时 loopback 服务上对比修复前后行为；Gateway、profile 和模型运行时使用受控替身，不启动真实 Agent、不修改该源码副本。要求包含这些模块的官方源码及其支持的 Python 版本。
在已安装 DSH 测试依赖的仓库中，可加 `--with-dsh`，验证真实 DSH SDK 发出立即回执请求，并通过同一任务/上下文取得晚到结果。

## 将审批等待回传给主控

部分原生版本会把 Gateway 的审批提示作为非最终消息忽略，同时返回发送成功。此时主控只能看到 `WORKING`，直到等待超时。仅有上面的异步回执修复仍不能表达这个中间状态。

`scripts/patch-hermes-a2a-approval.py` 包含异步修复，并通过 Hermes 已有的 `pre_approval_request` / `post_approval_response` 钩子更新原生任务。它针对已验证的根路径 / local profile 实现；不授予审批、不提交业务命令、不修改配置，也不代替原操作者作决定。

```bash
rtk proxy /actual/hermes/python scripts/patch-hermes-a2a-approval.py --hermes-root /actual/hermes-agent --check
rtk proxy /actual/hermes/python scripts/patch-hermes-a2a-approval.py --hermes-root /actual/hermes-agent --apply
rtk proxy /actual/hermes/python test/hermes-approval-reference.py --hermes-root /actual/hermes-agent --with-dsh
```

主控应以 `configuration.returnImmediately: true` 派单，再用原任务的 `GetTask` 读取状态。新版 Relay MCP `a2a_send` 和 DSH 插件均发送此配置。`GetTask` / `ListTasks` 在 `metadata.hermesApproval` 中提供固定原因、观察关联编号、请求时间、审批期限及受保护命令的未执行证据，不包含原始命令、审批理由或凭据。

| 事件 | 任务状态与原因 |
| --- | --- |
| 等待操作者审批 | `INPUT_REQUIRED` / `approval_required`，`commandExecuted:false` |
| 审批通过 | 同一任务恢复 `WORKING` / `approval_approved`；不声称命令已经执行 |
| 无人响应 | 立即记录 `approval_timeout` 和未执行证据；Gateway 本轮结束时最终为 `FAILED` |
| 操作者拒绝 | `approval_denied`，本轮结束时最终为 `REJECTED` |
| 审批通知无法送达 | `approval_notification_failed`，本轮结束时最终为 `FAILED` |

关联编号用于排查，不能作为批准凭据。`canRespondViaA2A:false` 表示操作者仍须通过接收端有效审批入口决定；主控发送“继续”不构成批准。`commandExecuted:false` 仅针对这次受保护命令，不表示此前的预检或整个任务都未执行。多项并行审批全部通过后才恢复 `WORKING`。

DSH 主控轮询的默认间隔上限为 5 秒（显式配置的上限保持不变），在等待审批时返回明确的未完成结果、原因和期限，工具查询保留这些字段；普通等待超时会再查询一次原任务，不自动取消或重新派单。审批状态修复同样需要从 Gateway 外部重新加载，且沿用上文的内存任务限制。应用前检查已有未决任务；脚本会验证原生方法、备份并保留文件模式，重复应用返回 `already_patched`，遇到不支持的源码或被修改的观察模块则拒绝覆盖。回归使用隔离 loopback、受控审批事件和真实 A2A/DSH 客户端，不调用模型或执行业务命令。

## 兼容服务范围

兼容服务只绑定 `127.0.0.1`，临时 token 自动生成，默认从 9900 起尝试 20 个端口；其他实例占用端口不会被误当成宿主 A2A。已有外部 adapter 使用明确的 `--local http://127.0.0.1:实际端口`。运行时验证 Agent Card 和认证后的只读 GetTask；已有官方模块未启用或不可达时报告失败，不启动兼容服务。

兼容实现提供 A2A 1.0 Agent Card、文本 SendMessage、GetTask 轮询、结果 artifacts 和 contextId 多轮会话。同一 context 的并发任务被拒绝。使用宿主 quiet CLI 输出的 `session_id:` 续接 `--resume`，跟随压缩后的 session ID；不同 context 独立。兼容子会话禁用 Connector Hook，避免递归启动。

旧宿主须支持 quiet CLI、退出码、session ID 和 resume；缺少输出、非零退出码、超时均返回失败任务，不猜测成功。无 SSE、推送或 CancelTask；任务/context 状态在内存中，重启后失效，闲置一小时清理。可通过环境设置 `A2A_COMPAT_PORT`、`A2A_COMPAT_PORT_ATTEMPTS`、`A2A_TASK_TIMEOUT_MS`（默认十分钟）、`A2A_HERMES_BINARY`。生产不要设置 `A2A_ALLOW_INSECURE`。
