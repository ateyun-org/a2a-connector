# Hermes 安装 A2A Connector

开始前阅读[通用配对与验证](shared.md)。Connector 优先使用当前 Hermes 自带的官方 A2A；只有确认没有官方模块时才安装和启动兼容服务。官方模块未启用、不可达或认证失败，都不会触发兼容模式。

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

5. 在目标 Agent 执行 `/a2a_connector doctor`，然后调用 `a2a_connector_pair` 或 `/a2a_connector pair`。插件先启动受管理的 worker，再返回该 worker 的有效审批信息；申请、自动续期和兑换都由同一个 worker 完成。用户批准后不需要 Gateway 重启，也不需要再手动兑换 token。

6. 使用 `a2a_connector_status` 或 `/a2a_connector status` 验证 `running`、`paired` 和 `tunnelOnline`。这三个状态分别表示 runner 存活、凭据已保存、CLI 的近期连接健康信息确认隧道在线。最后按[通用验证](shared.md#按顺序验证与排错)执行实际 A2A 请求。

## 日常管理与排错

| 命令 | 行为 |
| --- | --- |
| `/a2a_connector doctor` | 核对当前环境里的 Node/Python、源码能力、实际 state/PID/log 路径和运行状态；不申请审批 |
| `/a2a_connector status` / `a2a_connector_status` | 只读运行、配对与隧道健康；不显示 token |
| `/a2a_connector start` | 启动或复用同一状态文件的 runner；也识别手动启动的新版本 runner |
| `/a2a_connector pair` | 启动同一个 worker并返回有效审批信息；不会因为重复调用创建第二个 worker |
| `/a2a_connector stop` | 请求 runner 清理自己的 CLI、兼容服务和锁；保留凭据 |

插件启动 Hook 是 `on_session_start`，只有开始新 session 才触发；同一会话再发一句消息不等于新 session。不依赖 Hook 时可以直接调用 start/pair。普通 CLI 子命令 `hermes a2a_connector ...` 不存在。

从外部终端也可使用实际 Hermes Python 执行安装目录中的 `__init__.py status|doctor|start|stop|pair`。独立进程不自动读取宿主 `.env`，认证等环境应由有效的宿主环境提供；状态检查不需要本机服务 token。该入口管理 Connector，不重启 Gateway。

修改 `connector-config.json` 的 Node/Relay/local 等非敏感参数后，只需停止并重新启动 Connector，Gateway 内每次操作都会读取新值。修改宿主 `.env`、插件注册或官方 platform 时，才需要从外部重新加载 Gateway。切换状态路径前先停止原路径对应的 Connector，避免留下旧实例。

`WinError 2` 优先检查报错调用和实际可执行路径；没有匹配到日志不能证明插件没有 import。插件自检失败仍注册诊断工具。独立 Bash/Python 测试成功不能证明 Gateway 使用了相同的 home、Python、环境或安装副本。

stdout/stderr 都保存在 state 路径替换扩展名后的 `.stderr.log`，例如 `hermes.json` 对应 `hermes.stderr.log`；PID 镜像为 `hermes.pid`，不是 `hermes.json.pid`。Windows 使用当前用户和 SYSTEM 的受保护 DACL，POSIX 使用目录 0700/文件 0600。日志包含审批信息，保持私有，不直接整份贴入聊天；日志追加写入，按主机策略轮转。

运行身份由规范状态路径的 `.hermes-runner.lock/owner.json` 和 `.a2a-runtime.json` 管理，CLI 使用独立 `.lock`。`.pid` 是辅助文件，不是存活判断依据。runner 的 stop 请求绑定实例 ID，通过 IPC 让 CLI 退出；不使用 Python `os.kill(pid, 0)` 探测 Windows 进程。启动或受管理停止时会自动恢复已确认失效的本机旧锁，新版锁通过进程出生标识识别 PID 复用。跨主机、损坏或身份无法确认的锁仍需人工核实。CLI 异常退出后由同一 runner 退避重启；配置/配对错误停止自动重试。不要删除凭据来解决连接问题。自动启动仍由 Hermes 的 `on_session_start` 触发；操作系统开机自启需要宿主 Gateway 自身的常驻配置。

`.a2a-runtime.json` 可能包含兼容服务临时 token，status 不输出它。runtime 文件存在、进程存活、凭据落盘都不能单独证明 WSS 已连通。审批等待/短暂断线由 worker 自动处理，不需要 Gateway 重启。

## 兼容服务范围

兼容服务只绑定 `127.0.0.1`，临时 token 自动生成，默认从 9900 起尝试 20 个端口；其他实例占用端口不会被误当成宿主 A2A。已有外部 adapter 使用明确的 `--local http://127.0.0.1:实际端口`。运行时验证 Agent Card 和认证后的只读 GetTask；已有官方模块未启用或不可达时报告失败，不启动兼容服务。

兼容实现提供 A2A 1.0 Agent Card、文本 SendMessage、GetTask 轮询、结果 artifacts 和 contextId 多轮会话。同一 context 的并发任务被拒绝。使用宿主 quiet CLI 输出的 `session_id:` 续接 `--resume`，跟随压缩后的 session ID；不同 context 独立。兼容子会话禁用 Connector Hook，避免递归启动。

旧宿主须支持 quiet CLI、退出码、session ID 和 resume；缺少输出、非零退出码、超时均返回失败任务，不猜测成功。无 SSE、推送或 CancelTask；任务/context 状态在内存中，重启后失效，闲置一小时清理。可通过环境设置 `A2A_COMPAT_PORT`、`A2A_COMPAT_PORT_ATTEMPTS`、`A2A_TASK_TIMEOUT_MS`（默认十分钟）、`A2A_HERMES_BINARY`。生产不要设置 `A2A_ALLOW_INSECURE`。
