# 真实验证结果

> 1M 与会话隔离补充（2026-09-23）：先前 Harness 的 200K 宣告和 Bridge 默认参数已修正为每次请求 1M/max。两条并行 Harness 会话的 4 次 Qoder 策略回调均为 1M/max；各自的客户端会话键、Qoder session ID、工作目录和文件标记不同，续接只复用本会话。没有做接近 1M 输入的满载测试。详见 [专门核查](docs/context-and-isolation.md)。

> 后续进展（2026-09-23）：已通过 JSON 决策适配层接入运行中的 DeepSeek Harness，自定义 Provider `qoderbridge` 在模型目录可见；Harness 原生 `read`、`grep` 工具的调用、结果和最终答案已完成端到端验证。会话复用版模型总耗时约 42 秒，早期每轮冷启动版约 125 秒。随后通过预热、续接轮工具目录去重与长说明压缩，三次独立 Harness 原生读取任务分别在约 7.9、9.5、9.3 秒内完成；一次 `grep` 任务有约 39 秒的非模型等待波动。现由当前用户的 Windows 计划任务在登录后运行，独立于 Codex 任务。参见 [DeepSeek Harness 接入指南](docs/deepseek-harness.md)。以下记录保留此前 Qoder 原生拦截 Gate 的结论，不能用来否定新的适配路径。

日期：2026-09-23（Asia/Singapore）。SDK：`@qodercn-ai/qodercn-agent-sdk@1.0.48`；runtime：`1.1.61`。

## 结论

**Qoder CN 作为 DeepSeek 文本模型源已跑通；透明原生 tool-calling Provider 的 Gate 未通过。**

官方 CLI 授权已完成。真实目录返回 `dfmodel` / `DeepSeek-Flash`，支持 200K / 400K / 1M 和 low / high / max；本次使用默认参数。显示名未给出完整的 V4.1 版本，因此不声称已确认具体版本。

按照原方案，Gate 未通过时没有继续实现 HTTP Proxy 或 DeepSeek Harness 透明接入。已实现并真实验证 Minimal Action Protocol 文本 JSON 备用路径。

## 实验结果

| 实验 | 观察结果 | 结论 |
|---|---|---|
| 薄推理 | 返回 OK；1 个响应 request_id；API 7.003 秒 | 模型入口可用 |
| canUseTool deny+interrupt（早期配置） | 捕获参数；handler 未进入；2 个响应 request_id；插入拒绝结果 | 未通过 |
| PreToolUse stop+deny | hook_stopped 终态；1 个响应 request_id | 停止有效 |
| 同会话 native tool_result 续接 | 同一 tool ID 存在自动错误结果和宿主结果；未返回随机校验值 | 历史污染，续接失败 |
| PreToolUse defer（早期配置） | 继续进入 deny callback；2 个响应 request_id；插入拒绝结果 | 未实现宿主接管 |
| 修复环境后的 Hook 复测 | skills/plugins 均为空；仍有两份 tool result；模型返回自动错误文字 | 问题在干净配置下仍可复现 |
| JSON action | 返回合法 read_file 动作；1 个响应 request_id；tools/skills/plugins 均为空 | 备用输出路径可用 |

所有 handler 都是无文件操作的哨兵，没有读取目标文件，没有执行 shell。

## 复现

在仓库根目录运行：

```powershell
npm.cmd run models
npm.cmd run probe -- "Reply with exactly OK." --json --session-settings config/thin-cn.json
npm.cmd run gate -- --strategy hook --json --session-settings config/thin-cn.json
npm.cmd run action -- "Request reading src/main.ts from the host." --json --session-settings config/thin-cn.json
npm.cmd run report
```

备用协议实测返回：`{"action":"read_file","arguments":{"path":"src/main.ts"}}`。程序只产生并校验动作，不执行动作；宿主仍需提供执行器、循环和结果回传。

## 实测指标与证据

完整报告写在本机 `reports/telemetry.ndjson`（不入库），每条记录带 Bridge 实验 ID：

- 修复后的 JSON action：API 3.664 秒；首文本 4.211 秒；提交至终态 5.889 秒；初始化 37.386 秒；会话累计 0.01182104 Credits。
- 修复后的 Hook：首轮 API 3.398 秒、累计 0.0106904864 Credits；包含续接后会话累计 0.025326356 Credits。两个累计值不能相加。
- 薄推理、permission 与 defer 实验的结论见上表。

request-level Credits/original_credits/billable 未返回，Token 字段均为 0；有真实输出时不能将这些 0 视为可信计量。目前只有会话累计 Credits 可用。policy 回调次数也不能等同于模型调用次数：曾出现 callback 一次、响应 request_id 两个。

这些是可行性实验，不是性能对照。未执行完整 20/10/5 benchmark 和原生 Agent 对照，不能声称已经降低时间或费用。

## 本轮修复与验证

SDK 的 `env` 是整包替换。最初只设置追踪开关导致 Windows 路径环境丢失，出现 `undefined/temp`；代码已保留 `...process.env` 并增加回归断言。该问题已修复，无需重新登录。

`plugins: []` 不会自动关闭已安装插件。当前用公开启动 settings 或会话级覆盖关闭插件，干净配置已实测成功；没有改动用户全局插件设置。

增加公开会话历史审计、续接实验、计量质量标记和严格 JSON action 校验。类型检查、构建及 12 项测试通过。

## 尚未完成

1. 原生透明 Provider 需要不插入错误 tool_result 的官方宿主交接机制，以及可靠计量。
2. 采用当前备用路线需为 Harness 编写显式 JSON action 适配器，当前不是即插即用 Provider。
3. 可用路径定型后再做完整 benchmark、并发、分支和长期运行验证。

`phase2_ready=false`。没有 HTTP 模型端点，DeepSeek Harness 尚未接通。
