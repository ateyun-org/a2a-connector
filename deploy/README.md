# DSH adapter + Connector 常驻模板

先按 [DSH 安装指南](../docs/install/dsh.md) 配置同一常驻 DSH profile 中的 adapter 与 Connector。使用已配置模型的 `web` 或自定义常驻 profile，不使用一次性 `headless`。不要同时保留手动启动的同端口实例。本文是这两个服务模板的唯一配置说明。

## 服务环境

创建 `~/.config/a2a-connector/dsh.env`，文件权限 `0600`、父目录 `0700`。这是 shell 环境文件，只由本机服务用户编辑。保留既有模型凭据配置；不要将真实 token 提交仓库或发到对话中。

```sh
# 替换为本机真实路径；PATH 必须能找到 Node 22+（dsh 使用 env node）。
PATH='/ABSOLUTE/NODE/BIN:/usr/local/bin:/usr/bin:/bin'
DSH_BINARY='/ABSOLUTE/NODE/BIN/dsh'
DSH_PROFILE='web'
DSH_WORKDIR='/ABSOLUTE/TASK/WORKSPACE'
# 用安全编辑方式填入至少 32 字符的随机 token，与 patch 中变量名一致。
MY_LOCAL_AGENT_TOKEN='REPLACE_WITH_RANDOM_LOCAL_TOKEN'
# 自定义 DSH_HOME 或模型凭据如有需要也在此设置。
```

## Linux systemd 用户服务

替换 `dsh-a2a.service` 的 `/ABSOLUTE/PATH` 后，将副本放入 `~/.config/systemd/user/dsh-a2a.service`：

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-a2a.service
systemctl --user status dsh-a2a.service --no-pager
```

需要退出登录后仍运行时，按主机管理策略为服务用户启用 lingering。源码升级或环境改变后执行 `systemctl --user restart dsh-a2a.service`；只修改环境文件不需要 daemon-reload，修改 unit 才需要。

## macOS launchd 用户服务

替换 plist 中 `/ABSOLUTE/PATH`，将副本放入 `~/Library/LaunchAgents/com.local.dsh-a2a.plist`。用户 LaunchAgent 随登录启动、注销后停止；仅关闭终端不会停止。

```bash
plutil -lint ~/Library/LaunchAgents/com.local.dsh-a2a.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.local.dsh-a2a.plist
launchctl print "gui/$(id -u)/com.local.dsh-a2a"
```

源码升级或环境改变后执行 `launchctl kickstart -k "gui/$(id -u)/com.local.dsh-a2a"`。修改 plist 后先 bootout 原服务，再 bootstrap 更新的文件。

## 验证

服务应保持运行；在目标 profile 调用 `a2a_connector_pair` 查看身份和配对状态，由管理员核对确认码批准。随后从已授权主控调用 `a2a_agents`、发送任务并携带返回的会话 ID 追问，验证实际通路。不要将“服务启动成功”当作配对或任务成功。重启会使 adapter 内存中的 A2A task/context 映射失效；旧 ID 查询明确报错，重新发起会话即可。
