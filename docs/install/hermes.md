# Hermes 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)，然后按以下步骤安装 Hermes 插件。升级时，`plugins/` 下只能保留一个声明 `name: a2a-connector` 的目录；把旧目录移到 `plugins/` 外备份，单纯改名仍可能被扫描并注册同名 Hook。

## 安装与配置

若 Hermes 已提供可访问的本机 A2A origin，且不需要宿主内的配对工具/Hook，可改用[独立 Connector 安装脚本](../../scripts/install-connector.sh)：从仓库根目录执行 `sh scripts/install-connector.sh install --host hermes --relay wss://dsh-relay.chuanbota.com/connect --local http://127.0.0.1:9900`。此路径不会安装下方的 Hermes 插件；不要同时运行两种路径连接同一个 Agent。

从仓库源码安装前，如需测试，在仓库根目录执行 `npm ci` 和 `npm test`。默认测试不需要 DSH SDK；Hermes 插件目录本身仍无需 npm 安装。`npm run test:dsh` / `test:all` 是维护者验证 DSH 原生 adapter 的入口，需先安装 `plugins/dsh` 开发依赖。若旧版本默认测试报缺少 `@deepseek-ai/schemastery`，更新到拆分测试后的版本再验证；不要将失败当作已通过，也无需为 Hermes 安装 DSH SDK。同步脚本只更新 vendor 文件，不能修复测试依赖问题。

1. 确认 Hermes 进程可用 Node.js 22 或更新版本。升级已有安装时，先在旧插件仍可用的目标 Agent 中执行 `/a2a_connector stop`；Connector 是独立启动的子进程，Gateway 重启不保证它退出。随后将旧插件目录备份到 `plugins/` 外，再安装完整插件目录：

   ```bash
   hermes_root="${HERMES_HOME:-$HOME/.hermes}"
   mkdir -p "$hermes_root/plugins"
   if [ -e "$hermes_root/plugins/a2a-connector" ]; then
     mv "$hermes_root/plugins/a2a-connector" "$hermes_root/a2a-connector.backup-$(date +%Y%m%d-%H%M%S)"
   fi
   mkdir -p "$hermes_root/plugins/a2a-connector"
   cp -R "/absolute/path/to/repository/a2a-connector/plugins/hermes/." "$hermes_root/plugins/a2a-connector/"
   ```

   将示例仓库路径替换为仓库所在主机上的实际绝对路径；若启用了 `HERMES_HOME`，上面的命令会把插件安装到该 home。检查 `plugins/` 下其他备份目录的 `plugin.yaml`；凡是也声明 `name: a2a-connector` 的，都移到 `plugins/` 外。Hermes 随包已包含 `ws`，无需再执行 `npm install ws`；不要删除原有 Connector 状态文件。若旧插件已不可用，先按[通用验证步骤](shared.md#按顺序验证与排错)核对 PID 与命令行，只终止确认属于旧 Connector 的进程，再处理对应 PID 文件。

2. 这是 Hermes 的普通工具/Hook 插件，不是 Gateway platform 插件。先查看现有插件，再在目标 Hermes profile 中启用；不要把它配置到 `platforms.*.enabled`：

   ```bash
   hermes plugins list
   hermes plugins enable a2a-connector
   ```

   上述命令操作默认 profile。目标是命名的独立 profile 时，给两个命令都加同一个 `-p`，例如 `hermes -p "coder" plugins list` 和 `hermes -p "coder" plugins enable a2a-connector`。multiplex Gateway 只启用启动该共享 Gateway 的 profile。Hermes 的通用用户插件默认需要加入 `plugins.enabled`；`hermes plugins enable` 会更新该配置。见 [Hermes 插件文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md)。

3. 在该 Hermes 实例读取的环境文件中配置：默认安装使用 `~/.hermes/.env`；若设置了 `HERMES_HOME`，使用对应 home 下的 `.env`。独立命名 profile 使用它自己的 `~/.hermes/profiles/<profile>/.env`。保留原文件内容并将权限设为 `0600`。多 profile multiplex Gateway 是一个共享进程，而 Connector 直接读取进程环境；此时把 Connector 参数放入启动该 Gateway 的 home 环境中，不要假设它会按每个 profile 单独启动。`.env` 由宿主加载时，`/proc/<Gateway PID>/environ` 不一定反映加载后的 Python 进程环境，也不会自动给当前交互 shell 导出这些变量。

   ```text
   A2A_RELAY_URL=wss://dsh-relay.chuanbota.com/connect
   A2A_LOCAL_URL=http://127.0.0.1:9900
   # 如果本机 Agent 要求 Bearer token，填入 token 值，不是变量名：
   A2A_LOCAL_TOKEN=replace-with-local-agent-token
   # 服务 PATH 找不到 node 时，填写 Node.js 22+ 的绝对路径：
   A2A_NODE_BINARY=/absolute/path/to/node
   # 多个 Connector 实例时，为每个实例指定不同状态文件：
   A2A_CONNECTOR_STATE=/absolute/path/to/private/hermes-connector.json
   ```

   `A2A_LOCAL_TOKEN` 的值会作为 Bearer token 发送到本机 Agent Card 和 A2A endpoint。不要把真实 token 写进命令参数、配置示例或对话。

   其他可选变量：`A2A_AGENT_ID`、`A2A_ALLOW_INSECURE=1`。生产环境不要设置 `A2A_ALLOW_INSECURE`；固定 Agent ID 的使用场景见上面的参数说明。

   `A2A_NODE_BINARY` 默认是 `node`，要求 Connector 子进程的 PATH 能找到 Node.js。交互终端中的 `node --version` 成功不代表 systemd/launchd 服务也能找到它；给服务设置绝对路径更可靠。

   插件注册时会执行一次不发网络请求的自检：缺少必需环境变量、Node 路径或随包 CLI 时记 ERROR；未配对或等待审批会单独提示，但不阻止 session start hook 自动申请/恢复配对。`A2A_LOCAL_TOKEN` 仅在本机接口启用认证时需要，缺失不属于自检错误。

   启动失败在 Gateway 日志中以 ERROR 报告。子进程 stderr 保存在状态文件旁的 `hermes.stderr.log`（自定义 state 时替换其扩展名），权限 `0600`，重启追加写入；排查时检查该文件，不要把原始日志直接贴到对话中。日志不会自动轮转，需按主机日志保留策略管理。启动后立即退出会报退出码及日志路径；稍后发生的错误也会保留在该文件。命令报告“进程启动”不代表已配对或网络连通，仍需按下方步骤验证。

   Hermes Connector 的状态文件默认是 `~/.config/a2a-connector/hermes.json`，待审批请求写入该路径加 `.pending`，PID 文件是 `~/.config/a2a-connector/hermes.pid`。多个独立 Hermes/Connector 实例应设置不同的 `A2A_CONNECTOR_STATE`，避免共用身份文件。`A2A_ALLOW_INSECURE=1` 仅用于本地测试。

4. 让配置生效：

   ```bash
   hermes gateway restart
   hermes gateway status
   ```

   目标是命名的独立 profile 时，两个命令都使用同一个 profile，例如 `hermes -p "coder" gateway restart` 和 `hermes -p "coder" gateway status`。若该 profile 由 multiplex Gateway 服务，只重启共享的默认 Gateway：`hermes gateway restart`。Hermes Gateway 在进程启动时加载插件和环境；只运行 `hermes plugins enable` 不会让已经运行的 Gateway 立即加载它。普通 `.env` 内容变更后重启即可，不需要 `daemon-reload`。

   不要直接编辑 Hermes 生成的 systemd unit 中的 `Environment=` 行；Gateway 管理命令可能重新生成 unit 并覆盖该改动。默认优先用上述 `.env`。Linux systemd 用户服务如需独立环境文件，将变量放入 `~/.hermes/a2a-connector.env` 并设为 `0600`，然后给服务加 drop-in：

   ```bash
   systemctl --user edit hermes-gateway.service
   ```

   在编辑器中写入：

   ```ini
   [Service]
   EnvironmentFile=%h/.hermes/a2a-connector.env
   ```

   保存后执行（命名 profile 或 system service 请替换为实际 unit 和 scope）：

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart hermes-gateway.service
   systemctl --user status hermes-gateway.service --no-pager
   ```

   以上是默认 profile 的 user service 示例。用 `hermes gateway status` 和 `systemctl --user list-units 'hermes-gateway*'` 确认服务范围和 unit 名称；命名 profile 的独立 service 使用它自己的 unit，multiplex Gateway 使用默认 Gateway 的 unit。若安装为默认 profile 的 system service，执行 `sudo systemctl edit hermes-gateway.service`，再按同样顺序运行 `sudo systemctl daemon-reload`、`sudo systemctl restart hermes-gateway.service` 和 `sudo systemctl status hermes-gateway.service --no-pager`。命名 profile 请替换为实际 unit。不要把 `Environment=` 直接写回生成的主 unit。Hermes 的 Gateway 管理方式见[官方文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)。

   重启后在同一 profile 运行 `hermes plugins list`，确认 `a2a-connector` 已启用；再在 Agent 中确认 `a2a_connector_pair` 工具和 `/a2a_connector pair|start|stop` 命令已注册。Connector 的启动 Hook 是 `on_session_start`，重启 Gateway 本身不会触发它；如需立即启动，在目标 Agent 中执行 `/a2a_connector start`，或者开始一个会话触发 Hook。不要仅凭 Gateway 已监听本机端口判断 Connector 已启动。

完成安装后，按[通用配对与验证](shared.md#配对与授权边界)检查审批、凭据和连线。
