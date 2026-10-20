# 传播塔 WorkBuddy 部署包

此包包含 Linux amd64/arm64 Relay、接收端 CLI、远程 MCP 连接器及部署模板。它不会自动修改服务器或提交平台审核。完整授权流程见同目录 `workbuddy-mcp.md`。

## 部署前

在解压目录核对 `SHA256SUMS`，按服务器架构选择一个 Relay。运行依赖为 Redis、Node.js 22+、Python 3，以及现有 HTTPS 反向代理。先保存现有服务程序、配置、systemd unit、代理配置，并备份 Redis。保留原 Redis 数据、已有配对身份、ACL 和 WorkBuddy 加密密钥；不要把示例配置直接覆盖生产配置。

```bash
rtk proxy sha256sum -c SHA256SUMS
```

以下路径与 unit 文件一致，需由部署管理员创建两个独立系统用户：`chuanbota-relay`、`chuanbota-connector`。创建其私有状态目录 `/var/lib/chuanbota-relay`、`/var/lib/chuanbota-workbuddy` 并设置对应所有者，权限0700。程序及 unit 由 root 持有。

## Relay

1. 将所选 `relay/relay-linux-ARCH` 安装为 `/opt/chuanbota/relay/relay`，权限0755。
2. 参考 `relay/relay.example.json` 合并实际 Redis 和公共 URL 设置到 `/etc/chuanbota/relay.json`，权限0600且服务用户可读。启用 MCP；Redis 配置含密码时也只能保存在服务器。
3. 首次部署可用 `scripts/workbuddy-config.py init --env /etc/chuanbota/workbuddy.env --client-id ACTUAL_CLIENT_ID --agent-id chuanbota-workbuddy-cloud --mode both` 创建0600私有文件。若已有本地私有配置，应安全复制该文件而不是重新生成。若已有 Relay 管理员凭据，沿用既有强凭据；已有 WorkBuddy 令牌时必须保留原 `WORKBUDDY_TOKEN_KEY`。由账号持有人填写真实 `WORKBUDDY_CLIENT_SECRET`，不用聊天传递。
4. 执行私有配置 `check`，结果须 ready=true。安装 `relay/chuanbota-relay.service` 到 `/etc/systemd/system/`，核对文件所有者后执行 daemon-reload 和启动。
5. 把 `relay/nginx-workbuddy.conf` 中的路由合并到现有 HTTPS server，先 `nginx -t`，成功后再 reload；保留原隧道和管理路由。服务端监听127.0.0.1:8020。
6. 执行 `scripts/check-workbuddy-deployment.py --base https://dsh-relay.chuanbota.com`。该无凭据检查不会产生配对或任务，也不能代替真实账号验收。

## WorkBuddy 接收端

将 `workbuddy/workbuddy-a2a-connector-VERSION.zip` 解压到 `/opt/chuanbota/workbuddy`，在该目录安装依赖：

```bash
rtk npm ci --omit=dev
```

使用 `chuanbota-connector` 用户，并为以下全部命令保持同样环境：

```bash
rtk proxy env A2A_CONNECTOR_CONFIG_DIR=/var/lib/chuanbota-workbuddy A2A_CONNECTOR_INSTANCE=cloud /usr/bin/node /opt/chuanbota/workbuddy/cli.js setup --mode cloud --relay wss://dsh-relay.chuanbota.com/connect --agent-id chuanbota-workbuddy-cloud --name '传播塔云端受控'
```

setup 输出配对入口与确认码；管理员核对后批准。仍用同一用户及上述两个环境变量执行 cli.js 的 `platform login` 获取登录地址，由账号持有人完成官方 OAuth；随后执行 `platform status` 和 `doctor`。若未 ready，按提示解决，不重复创建新身份。

首次 setup 启动了后台进程。先执行同一 cli.js 的 `stop`，然后安装 `workbuddy/chuanbota-workbuddy.service`、daemon-reload，交给 systemd 启动。该服务已配置相同用户和状态目录。不要把 WorkBuddy Client Secret 传给接收端服务。

## 主控应用与上线顺序

`workbuddy/chuanbota-a2a-mcp-VERSION.zip` 上传到开放平台的**连接器**创建入口。此包不是应用静态资源包。服务可用后提交连接器审核，审核通过后再在 Buddy 应用的市场连接器和首页内置连接器中选择它；完成用户 MCP OAuth，管理员明确授予目标 Agent 权限。

未保存的应用编辑必须先导出配置；连接器待提交页也不能当作已发布。真实 Secret、上游授权、受控服务 doctor、目标 ACL、平台连接器审核和应用绑定均完成后，用一项小任务做真实账号端到端验收。

## 回退

停止新接收端服务和 Relay，恢复保存的程序、服务配置及代理路由；验证代理配置后再启动旧服务。保留 Redis 和加密密钥，不清空配对或任务记录。MCP 为新增 Redis 键，停用 MCP 后原 A2A 路由仍可使用；不要在回退中重新发送状态不明的任务，应查询原 request receipt。
