# WorkBuddy 服务端托管接入

Relay 已内置 Go 接收端，身份、账号和授权统一来自 MySQL。用户电脑和 WorkBuddy 任务沙箱不需要运行 A2A 服务、Node Connector 或独立托管容器。完整运行与恢复说明见 [Relay 原生接收端](../../../a2a-relay/README.md#native-go-workbuddy-receiver)。

1. 企业管理员进入 `/console` → Agent 管理 → 接入 Agent → WorkBuddy，创建或选择归属正确的接收身份。
2. 选择电脑端或云端说明，显式生成账号授权邀请，交给该身份的实际持有人。持有人打开邀请并授权自己的 WorkBuddy 账号；不需要管理员密钥。
3. 电脑端在官方 WorkBuddy 中开启「连接移动端 → 小程序 → 允许移动端连接此设备」，保持电脑在线。云端执行不依赖电脑。手机完成账号授权只代表 OAuth 完成，不能证明电脑接收就绪。
4. 在目标身份的「谁能访问」中选择实际机器调用方并授予查看、调用、读取任务等动作；个人调用方还需要绑定成员的有效权限交集。创建身份和账号授权不会自动授权调用。
5. 刷新列表查看托管接收端状态，再在用户明确授权真实测试后验证任务。接收端就绪与电脑在线是不同状态。

原生运行时每五秒从 MySQL 读取接收身份，不使用配置中的全局 Agent ID 清单或 Redis 身份。停用身份、成员或组织会停止对应接收端；数据源失联时拒绝接收。Redis 仅保存运行租约及加密任务/请求日志等状态。

SendMessage 的 `params.message.metadata.workbuddyMode` 可选择 cloud 或 desktop，省略使用接收端默认值。同 messageId 重试和同 context 后续轮次保持原位置；已有未决任务时不能另发新工作。保存原 taskId、contextId、messageId 和 Relay 收据，超时后查询原任务，不新建指令。ListTasks 不开放；只查询当前调用方自己创建的任务。

新用户创建独立身份；不要覆盖别人的 WorkBuddy 账号。保留数据库、Redis 和加密密钥。账号授权不触发任务，安装检查也不自动派发业务。
