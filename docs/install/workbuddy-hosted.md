# WorkBuddy 服务端托管接入

架构为 主控 → Relay → 服务端 WorkBuddy 适配器 → 官方云端 API / 官方电脑端 API。用户电脑不运行本项目的 A2A 服务或 Connector；电脑端执行仍要求官方 WorkBuddy 已登录、在线并允许远程连接。云端执行不依赖用户电脑。托管服务应放在持续运行的服务器，不能依赖会休眠的 WorkBuddy 任务沙箱。

一套服务可托管多个接入身份，共用 Node 主进程。每个身份保留独立的 Relay 隧道、配对凭据、WorkBuddy OAuth 授权和任务记录，不要求每个用户一台服务器。每个身份的云端和电脑端共用同一 OAuth 身份，执行队列分别串行。应用 Secret 仍只在 Relay；接收端不配置 Client Secret，也不把主控的 token 用作用户身份。当前通过管理员配置明确的身份清单，不宣称已经实现用户自助注册、计费或任意规模容量。

## 单账号试用：保留现有 Relay 配置

默认使用现有 `chuanbota-workbuddy-cloud`，Relay 为 `wss://dsh-relay.chuanbota.com/connect`，启用两种执行位置，默认云端。现有 Relay 已配置这个身份及四项权限时，无需修改 Nginx 或新增公网端口。适配器只监听服务器内部 loopback，通过出站 WSS 接入原 Relay。

部署包解压后，将 workbuddy/workbuddy-a2a-connector-VERSION.zip 解压到同一个 workbuddy/ 目录，使 Dockerfile、package.json、hosted.js 在同一级。用独立 Compose 文件启动，不改变原 Relay 服务：

```bash
rtk proxy docker compose -f compose.workbuddy-hosted.yaml up -d --build
rtk proxy docker compose -f compose.workbuddy-hosted.yaml logs --tail 50 workbuddy
```

首次运行申请配对。管理员在日志显示的原 Relay 审批页核对 Agent ID 和确认码后批准；不要自动审批。不再运行旧本机/沙箱接收端。同一 ID 重新配对会轮换旧凭据，其他已批准主控的目标 ACL 保留；WorkBuddy OAuth 仍绑定这个身份。

配对后获取官方账号授权引导页，再检查状态：

```bash
rtk proxy docker compose -f compose.workbuddy-hosted.yaml exec workbuddy node hosted.js authorize
rtk proxy docker compose -f compose.workbuddy-hosted.yaml exec workbuddy node hosted.js status
```

由账号持有人打开 authorize 输出的 URL 完成授权。若现有账号授权仍有效，可直接检查 status。status 的 linked/tunnelOnline 不证明 PC 开关已开或某个任务已完成；用真实小任务分别验收两条执行路径。

数据卷 /data 持久保存凭据、配对请求和任务日志。容器替换不清空状态。配置了 restart 策略，服务器本身仍须保持运行。

## 原任务迁移

迁移前停止原接收端，保存原私有身份文件与 `.tasks.json`，不要 logout、release 或重新派发原任务。通过私有文件传输将原文件放入卷中，分别命名为：

```text
/data/chuanbota-workbuddy-cloud.json
/data/chuanbota-workbuddy-cloud.json.tasks.json
```

文件保持0600，目录0700，容器 node 用户可读写。不要把 token 或完整凭据文件贴给模型，也不要混入安装包、Git 或日志。如果只重新配对而没有迁移日志，原 task ID 无法由新实例查询；仅知道云端 task ID 不能替代原始派发记录。已有 hosted 配置也可用 stateFile 指向原路径，避免改名。

双模式服务继续沿用上述原云端任务日志；新电脑端记录存为 `<stateFile>.desktop.tasks.json`。重启后仅只读核实原云端会话，不重发。能够恢复的正文与产物可先读回；缺少结束信号时仍标记未核实，不伪造完成或自动释放队列。

## 选择执行位置

原来的 SendMessage/GetTask 接口保持不变。SendMessage 的 message 增加 metadata.workbuddyMode，明确选择 cloud 或 desktop；省略时新任务采用默认 cloud。同 context 后续轮次与同 messageId 的重复查询沿用原位置；不允许用同 ID 切换位置重试。

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": {
    "message": {
      "role": "ROLE_USER", "messageId": "本次唯一ID",
      "metadata": {"workbuddyMode": "desktop"},
      "parts": [{"text": "实际完成这个任务并返回验证依据"}]
    }
  }
}
```

Cloud 模式把 workbuddyMode 改成 cloud。Agent Card 同时公布两个 skill 和默认位置。电脑端仍在 WorkBuddy 中手动开启 左下角「连接移动端」→「小程序」→「允许移动端连接此设备」。主控沿用已有 Relay 目标 ACL，不需要安装新的接收端。不得因超时或休眠而改 messageId 再派发，应查询原 task ID。

## 多用户托管

通过私有托管配置列出身份；程序从 A2A_HOSTED_CONFIG 或数据目录下 hosted.json 读取，也可显式传入 `node hosted.js serve /path/hosted.json`。每个身份均需管理员配对批准，再由对应用户授权。

```json
{
  "relay": "wss://dsh-relay.chuanbota.com/connect",
  "stateDir": "/data",
  "receivers": [
    {"agentId": "user-a", "name": "用户A", "adapter": "hybrid", "defaultMode": "cloud"},
    {"agentId": "user-b", "name": "用户B", "adapter": "hybrid", "defaultMode": "cloud"}
  ]
}
```

Relay 新版支持 workbuddy.agentIds 明确允许多个身份；旧 workbuddy.agentId / WORKBUDDY_AGENT_ID 继续兼容，二者为允许集合的并集。新清单不能用 `*`。管理员增加身份时需将其加入这个允许集合；仅创建托管 receiver 不授予上游授权或主控 ACL。每次 OAuth 回调和访问令牌读取仍由认证后的真实 Agent ID 索引，不能通过请求参数选择另一用户。此处只说明新配置接口，不自动修改现有服务器配置文件。

## 验收顺序

1. 停止本机/原沙箱接收端，保留原凭据和任务记录；服务器 status 显示隧道及授权就绪。
2. Hermes 用同一目标 ID、一个新 messageId，选择 cloud 创建测试文件、实际读取并计算 SHA256。
3. 选择 desktop，在用户电脑 WorkBuddy 中完成另一项可验证任务，确认没有本机 A2A/Connector 进程。
4. 用户电脑关机后，再派发新的 cloud 任务；电脑端此时应报告离线，不能伪造完成。
5. 关闭手机云端页面并空闲后继续派发云端任务，确认 Relay 接收身份不随该沙箱休眠而离线。

模拟测试不能替代实际服务器部署、真实账号与最终关机验收。
