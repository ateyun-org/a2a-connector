# OpenClaw 安装 A2A Connector

开始前阅读[通用准备、配对与验证](shared.md)。Connector 默认优先使用 OpenClaw 的官方 A2A；宿主缺少 A2A 时，安装并启动本项目的兼容服务。只运行一个 Connector 连接同一个 Agent。

## 自动选择并安装

在 OpenClaw Gateway 所在主机、`a2a-connector` 仓库目录执行：

```bash
node scripts/install-openclaw.mjs
```

脚本先读取**该宿主**的 `openclaw plugins list --json`，不按版本号猜测能力，也不会安装或升级 OpenClaw 本身：

- 发现官方 `a2a` 插件：验证 Agent Card 和认证后的只读 `GetTask` 请求，只安装 Connector，不安装兼容服务文件。
- 确认插件清单中没有 A2A：安装 Connector 及兼容服务。启动时只绑定 `127.0.0.1`，默认从 9900 起尝试 20 个端口，实际端口自动传给 Connector。
- 官方 A2A 已有但未启用、认证失败、Gateway 不可达，或能力清单无法读取：停止安装并给出修复提示，不另起兼容服务。

官方 A2A 自 OpenClaw `2026.8.1` 正式版随包提供，但需要先启用并配置专用 peer token，见[官方 A2A 文档](https://docs.openclaw.ai/channels/a2a)。在现有配置中合并：

```json5
{
  channels: {
    a2a: {
      enabled: true,
      peers: {
        connector: { token: "${OPENCLAW_CONNECTOR_A2A_TOKEN}" }
      }
    }
  }
}
```

为安装脚本和 Gateway 环境设置同一个强随机 `OPENCLAW_CONNECTOR_A2A_TOKEN`。使官方 A2A 配置生效后安装：

```bash
node scripts/install-openclaw.mjs --local-token-env OPENCLAW_CONNECTOR_A2A_TOKEN
```

Agent Card 可以匿名读取，不能单凭 Card 判断任务认证成功；安装脚本还会验证 peer token。该 token 与 Relay 配对后保存的 Connector 凭据是两个不同的凭据。兼容服务自动生成临时 token，随 Connector 子进程传递，不需要配置上述官方 channel 或 token。

非默认主机参数须与运行中的 Gateway 一致：

```bash
node scripts/install-openclaw.mjs \
  --openclaw-binary /absolute/path/to/openclaw \
  --profile reviewer --gateway-port 19876 \
  --local-token-env OPENCLAW_CONNECTOR_A2A_TOKEN
```

`--gateway-port` 默认 18789；`--profile` 和 `--openclaw-binary` 选择实际宿主 CLI。已有独立 A2A origin 时可传 `--local http://127.0.0.1:9900`，这会只安装 Connector 并验证指定服务，不替换它；此时下方插件配置的 `local` 也须填写该 origin。脚本只安装插件，不覆盖现有宿主配置。临时安装目录在成功或失败后都会清理；检测失败时不会安装依赖或写入宿主插件。

## Connector 配置

在现有 OpenClaw 配置中合并以下条目，不要覆盖其他配置：

```json5
{
  plugins: {
    entries: {
      "a2a-connector": {
        enabled: true,
        config: {
          relay: "wss://dsh-relay.chuanbota.com/connect",
          local: "auto",
          // 使用官方 A2A 时必填；旧版兼容服务不需要：
          // localTokenEnv: "OPENCLAW_CONNECTOR_A2A_TOKEN",
          // Relay 上的稳定 ID：
          // agentId: "my-agent",
          // 旧版宿主执行任务的 Agent ID，与 Relay agentId 不同：
          // openclawAgent: "main",
          // 非默认 profile/CLI：
          // openclawBinary: "/absolute/path/to/openclaw",
          // openclawArgs: ["--profile", "reviewer"],
          // 同机多个 Agent 时，每个实例须使用不同的绝对状态路径：
          // state: "/absolute/path/to/private/openclaw-reviewer.json"
        }
      }
    }
  }
}
```

`local` 缺省也表示 `auto`，启动时会重新检测宿主能力；旧版升级后默认转用官方 A2A，须先启用官方 channel 并配置 `localTokenEnv`。原先只安装了 Connector 的新版本宿主若降级，则需按宿主插件更新流程重新运行本脚本，补装兼容文件。指定 `local` HTTP(S) origin 时直接复用它，认证或发现失败也不会自动启动兼容服务。

开发时可使用源码链接安装；它包含全部源码，但兼容模块仍只在确认缺少 A2A 后加载：

```bash
npm --prefix "/absolute/path/to/repository/a2a-connector/plugins/openclaw" ci --omit=peer
openclaw plugins install --link "/absolute/path/to/repository/a2a-connector/plugins/openclaw"
```

插件采用旧版支持的普通注册入口，不要求新的 `openclaw/plugin-sdk/plugin-entry`。旧版须具有 `plugins list --json`、插件 service/tool 注册和 `agent --agent --session-id --message --json` CLI；更早缺少这些接口的宿主会明确报错。

## 启用与验证

```bash
openclaw plugins enable a2a-connector
openclaw plugins inspect a2a-connector --runtime --json
```

进入目标 Agent 实际调用 `a2a_connector_pair`。安装/启用后的生效方式取决于宿主版本；新版支持插件热加载，旧版可能需要重启 Gateway。`inspect --runtime` 在 CLI 进程内载入插件，不单独证明运行中的 Gateway 已加载。检查 Gateway 日志中的 `A2A Connector: native/existing/compat A2A at ...`，再按[通用配对与验证](shared.md#配对与授权边界)核对审批、凭据和真实任务。

兼容实现提供 A2A 1.0 JSON-RPC `SendMessage`、`GetTask`、Agent Card、文本结果 artifact 和 `contextId` 多轮会话。默认异步返回任务；客户端可轮询，或设置 `configuration.blocking: true` 等待结果。每个 context 对应独立 OpenClaw session，同 context 的并发请求被拒绝；带同 context/messageId 的重试复用原任务。任务/会话记录保存在内存，闲置一小时清理，重启后失效。CLI 默认任务超时十分钟，可用 `taskTimeoutMs` 调整。

兼容服务不宣称完整 A2A 功能：未实现流式响应、推送和任务取消。关闭服务或杀掉 CLI 不能证明 Gateway 中的工具执行停止，因此 `CancelTask` 返回不支持，不伪造 canceled 状态。

若本机 A2A 已经就绪且不需要宿主内的配对工具，也可使用[独立 Connector 安装脚本](../../scripts/install-connector.sh)；该脚本只接已有 origin，不会安装本页的 OpenClaw 插件。不要同时运行两条路径。
