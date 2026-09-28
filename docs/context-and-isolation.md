# 1M 上下文与会话隔离核查

日期：2026-09-23。本文件说明当前 `qoderbridge/qoder-deepseek-flash` 在 DeepSeek Harness 与 Qoder CN 两侧的实际配置及实测边界。

## 1M 参数

先前 Bridge 只固定模型 ID，Harness 向用户显示 200K；**当时并没有真正启用 1M**。现已修正为两层一致：

1. Harness 的 `llm-pi-ai.providers.qoderbridge.models[qoder-deepseek-flash].contextWindow` 为 `1,000,000`，通过官方 Settings API 写入。修改前的非敏感 Provider 快照在 `reports/dsh-provider-before-1m.json`。
2. Bridge 的每个 Qoder SDK 模型请求都经过官方 `resolveModel` 策略，返回运行时发现的 `dfmodel`，参数 `contextWindow: 1_000_000`、`reasoningEffort: 'max'`。若模型目录不再支持这些参数，Bridge 明确报错，不静默退回 200K。

独立 SDK 短请求返回预期 `1M_OK`；两条并行 Harness 工具任务合计四次 Qoder 模型策略回调，均记录 `context_window: 1000000` 和 `reasoning_effort: max`，结果成功。Harness 会话投影的 `contextWindow` 也为 `1000000`。[Qoder CN 官方模型策略说明](https://docs.qoder.cn/cli/sdk/model-policy)支持对每次请求传入上下文窗口，并以实时模型目录核对可用选项。[Qoder CN 模型文档](https://docs.qoder.cn/cli/models)列出了 1M 选项。

**验证边界：**已验证 1M 模式可启动且短请求成功，没有发送接近 1M 的高成本输入来做满载测试。Qoder 当前目录同时给出 1M `context_config` 和 `maxInputTokens: 180000`；这些字段的服务端边界未通过大输入实测厘清。因此对话接近 180K 输入后仍应关注实际错误与压缩行为，不能仅凭设置值保证满载 1M 成功。

## 会话隔离

Harness 自定义 Provider 将自己的 Session ID 经 Chat Completions 的标准 `prompt_cache_key` 送到 Bridge（本地 Provider 使用 `cacheRetention: long` 与 `supportsLongCacheRetention: true` 来让已安装的 pi-ai 适配器发送它；Bridge 不调用私有端点）。Bridge 优先用该标识查找 Qoder SDK Session，续接时还要求之前的消息是当前请求的精确前缀。不同 Session ID 不共享 Qoder 的输入队列、流、模型历史、Credits 累计和工具调用状态；分支或回滚导致前缀变化时创建新的 Qoder Session。日志仅记录会话键的短哈希，不保存原文。

并行实测创建了两个不同工作目录、不同随机文件标记的 Harness 会话：

| Harness 会话 | 原生工具 | Qoder session ID | 会话键短哈希 | 结果 |
|---|---|---|---|---|
| 会话 A | `read` | 独立 ID A | 独立哈希 A | 只回答本会话标记 A |
| 会话 B | `grep` | 独立 ID B | 独立哈希 B | 只回答本会话标记 B |

两条会话的首轮各自建立 Qoder Session；各自第二轮 `reused_session=true`，且只复用本会话的 Qoder ID。Harness 的 `tool/result` 与最终回答都包含自己的标记、没有包含对方标记。`tests/routing.test.ts` 还覆盖“两个客户端即使有相同 tool-call ID，显式会话键也不能误合并”和“分支历史不能复用旧会话”。

复验命令（在项目目录；会话 ID 与标记来自 `scripts/dsh-native-smoke.ts` 的输出）：

```powershell
npm.cmd run status
node --import tsx scripts/verify-isolation.ts <会话A> <标记A> <会话B> <标记B>
```

Bridge 重启后内存中的会话映射会消失；Harness 随下次请求重发完整历史，Bridge 会创建新的 Qoder Session，不会接到另一个会话的旧状态。没有标准会话键的其它客户端仍使用随机 tool-call ID 作兼容关联，这一兼容路径不具备 Harness 显式会话键的隔离强度。
