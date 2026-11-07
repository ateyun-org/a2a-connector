# Hermes 原生 A2A 部署补丁

[`hermes-native-async-v2.patch`](hermes-native-async-v2.patch) 保存已部署的原生源码差异，供审阅、复现和版本管理。

| 项目 | 值 |
| --- | --- |
| 修复版本 | `connector-native-async-v2` |
| 上游仓库 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| 基线提交 | `f14699a1379838862d3020b97785796aa555d36d` |
| 修改文件 | `plugins/platforms/a2a/adapter.py` |
| 范围 | 根路径 / local profile 的立即回执及完成回复的 profile 上下文保留 |

```text
原文件 SHA-256:
a7ece70509f163688d3fe77388b6a77219ab637c1b2f3c4cc88c49baa3d39038

部署后文件 SHA-256:
839213194f5073c8d15d813bf087c23bbab04b16267bee1b03b8508aa19d4978

补丁文件 SHA-256:
4326b197e2965399a5cd0377abce384e428dbf18d34f64e992ae128de9c986c2
```

本次同步已验证：在上述干净基线上通过 `git apply --check` 并应用补丁，得到的文件与服务器部署文件逐字节一致；现有[修复脚本](../scripts/patch-hermes-a2a-async.py)从同一基线生成的结果也完全一致。

实际部署优先使用修复脚本，它会核对宿主结构、保存备份并原子写入。操作与重启要求见 [Hermes 安装说明](../docs/install/hermes.md#原生-a2a-的五分钟长任务超时)。这个补丁文件记录特定基线的精确差异；更新 Hermes 后应重新检查兼容性。

上游代码许可为 [MIT](https://github.com/NousResearch/hermes-agent/blob/f14699a1379838862d3020b97785796aa555d36d/LICENSE)。

## 审批状态观察补丁

[`hermes_approval_state.py`](hermes_approval_state.py) 由 [`patch-hermes-a2a-approval.py`](../scripts/patch-hermes-a2a-approval.py) 安装为原生平台的 `approval_state.py`。修复版本为 `connector-approval-state-v1`，包含上述异步修复，并在已验证的原生方法中接入审批生命周期钩子、任务投影和最终结果分类。它不改变审批决定或命令执行权限。

检查默认不修改目标文件；应用会保存带摘要的原文件备份，并在写入失败时恢复已替换文件。辅助模块被修改、原生方法与已验证实现不一致或缺少 profile-aware thread helper 时拒绝覆盖。范围、状态字段、回退与重启要求见 [Hermes 安装说明](../docs/install/hermes.md#将审批等待回传给主控)。

[`hermes-approval-reference.py`](../test/hermes-approval-reference.py) 在临时 loopback 服务中验证真实原生 adapter/protocol/security，复现修复前的审批消息丢失，并验证等待、超时、通过、拒绝、通知失败、任务/profile 隔离及真实 DSH SDK 主控可见性。只替换 Gateway/模型运行时与审批事件，不执行业务命令，也不改动传入的源码目录。
