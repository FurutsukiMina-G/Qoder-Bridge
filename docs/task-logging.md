# 实际任务日志

Bridge 向 `reports/tasks.ndjson` 追加每次 Harness 请求的记录；`telemetry.local_response_replay=true` 表示本地重复请求复用，没有新模型调用，应与模型请求分开计数。相同的 `harness_session_key_hash` 可关联会话轮次；`bridge_request_id` 可与 `reports/bridge.ndjson` 的 SDK 遥测对照。

记录包括：

- 时间、成功或错误、模型、Qoder session ID、是否复用会话；
- 本轮 Harness 用户任务文本（最多 4,096 字符/条）、工具结果摘录（最多 1,024 字符/条）、长度和 SHA-256，及被截断标记；
- 本轮提供的工具名称、完整定义字符数、实际发送给 Qoder 的定义字符数与整体提示字符数；
- 模型给出的最终答案摘录或工具名与参数摘录（最多 2,048 字符）；
- Qoder API/墙钟/首文本延迟、当前轮次 Credits 增量与 1M/max 模型策略记录。
- `first_client_text_ms` / `first_client_thinking_ms` 与 SSE 块数，用于验证即时输出；文本块数不是 token 数。
- `usage`、`usage_source`：计量得到的输入/输出/推理 token（`qoder_context_ratio+stream_token_deltas`），无法可靠计量时为空；`context_usage_ratio` 为原始比值，`output_tokens_per_second` 为 Bridge 观测的解码速度。
- `client_usage`、`client_cache_usage`：实际发给 Harness 的 usage 及其缓存来源：`credits_inverse`（默认，由账单反推）、`session_prefix_estimate`（前缀估算或反推失败时的回退）或 `omitted`。
- `cache_billing`：最后一次尝试由 Credits 反推的命中/未命中 token、计费时段 `tier` 与日历时段 `calendar_tier`；`billing_tier` 便于按时段汇总。
- `cache_status` 为 `not_reported_by_qoder` 时 `cache_hit_ratio` 为空；`cache_estimate_tokens` / `cache_estimate_ratio` 是会话前缀估算，始终记录，不是上游计量。
- `requested_reasoning` 为实际请求的推理等级；`reasoning_guard` / `reasoning_guard_stops` 记录推理守卫的上限、中断时的推理 token 数和中断次数。

系统与 developer 消息只记角色、长度和哈希，不记正文。Harness 会话键只存短哈希；Bridge 密钥、Qoder 凭据和认证头不会写入。摘录可能仍包含任务文本、文件内容或命令输出，所以日志保存在本机被 `.gitignore` 排除的 `reports/` 目录，不应直接公开。

在仓库根目录查看当前服务与按会话汇总：

```powershell
npm.cmd run status
npm.cmd run tasks:report
npm.cmd run tasks:report -- --session <DeepSeek Harness 的 sessionId>
npm.cmd run metrics -- --limit 20
```

汇总输出每个会话的模型请求数、失败数、工具调用名、工具结果数、记录到的 Credits 合计、输入/输出 token、Qoder 等待时间与发送提示字符数。Credits 为 SDK 会话累计数的相邻差值；若轮次缺少计量，汇总显示 `null`，不推断零费用。SDK 自带的 Token 字段返回零，日志不把它们当作 token 数量；token 列来自上述计量，任一模型请求未计量时该会话合计为 `null`。第一条任务日志会在新代码重启并收到下一次 Harness 请求后产生；旧的 `reports/bridge.ndjson` 保留此前模型指标，但无法补回旧任务的用户文本。
