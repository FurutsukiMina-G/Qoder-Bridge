# Opus 改动复核与 Pro 适配（2026-09-28）

## 已确认的既有修改

项目没有 Git 历史，本轮通过源码、测试、现有文档和运行报告复核，不能声称得到精确的作者级 diff。开始适配前的完整代码备份位于 `.runtime/opus-review-baseline-20260927`。

- `usage.ts` / telemetry：使用窗口占用比与流式 delta 计数推导输入、输出、推理 token 及 tok/s；优先采用可用的真实计数，缺少必要信号时不报告推导值。本地重放上报 0 用量。
- 缓存：加入 `--cache-usage estimate` 可选会话前缀估计；默认 `none`，真实命中状态仍未知。日志同时保留来源和估计数。
- 会话池：每分钟清理超过 20 分钟的空闲会话，回收已被分支/压缩替代的空闲会话，预热失败后重试并报告错误。
- 测试：支持独立 `reportDir`，避免 fixture 混入生产任务日志。修改前 49 项测试和类型检查通过。

这些功能已保留。文档中“每个 delta 必定是一个 token”改为受控样本支持的假设；分块启发式无法证明精确性。此前“先监听端口再预热”也按实际代码订正为等待首次预热尝试结束后监听。

## 本次 Pro 适配

认证后的官方 SDK 模型目录确认 `dmodel` 为启用的 `DeepSeek-V4-Pro`，支持 1M/400K/200K 窗口、high/max 推理和 32000 最大输出目录值。证据：`reports/deepseek-catalog.json`。

| Harness 模型 | Qoder 实际 ID | 当前策略 |
|---|---|---|
| Qoder DeepSeek Flash (`qoder-deepseek-flash`) | `dfmodel` | 1M/max |
| Qoder DeepSeek V4 Pro (`qoder-deepseek-pro`) | `dmodel` | 1M/max |

两个模型均由现有 `http://127.0.0.1:8646/v1` 提供。请求按模型精确路由，响应模型名保持一致；目录缺失或模型禁用会失败，不回退到另一模型。各自拥有独立会话池、历史、工具目录缓存、Credits 差分和重复请求复用状态，共用最多 3 个并发请求的限制。启动仅预热 Flash；Pro 首次使用可能有额外初始化延迟。

Harness 注册脚本以增量方式加入 Pro，保留原模型配置；在界面选择所需模型即可。状态脚本会显示当前默认选择。Bridge 不批量改变既有任务，跨进程恢复和 1M 满窗口压力测试仍未完成。

## 验证结果

- 51 项离线测试、类型检查和构建通过。新增 Pro 精确选择、不可用失败、参数检查、JSON/SSE 路由与模型标签测试。
- 相同 Harness 会话键、相同输入依次请求 Flash/Pro/Flash/Pro：前两次分别返回 `DeepSeek-Flash` 与 `DeepSeek-V4-Pro`，Qoder 会话 ID 不同；后两次各自本地复用，新增 Credits 均为 0。合计 **0.0792934032 Credits**。见 `reports/pro-smoke.json`。
- Harness Pro 原生读取测试：实际 `read` 的结果含随机哨兵，最终正文准确返回哨兵；正常完成，2 次模型请求、0 错误，均确认为 `dmodel` / `DeepSeek-V4-Pro` / 1M/max。续接复用原 Qoder 会话且不重发工具定义。合计 **0.934159908 Credits**。见 `reports/pro-native-smoke.json`。
- Pro 原生测试的最终回答首思考约 2.488 秒、首正文约 3.165 秒，实时 SSE 已收到；第一步工具参数完整校验后交由 Harness 执行。原生 `read` 已验证，其他工具使用相同通用转换，但 Pro 尚未逐一验收。
- 两组模型验证合计 **1.0134533112 Credits**。这是短样本，不能推算长期价格/速度优势；Pro 原生测试首轮约 0.8362、续接约 0.09794 Credits，不能用旧 Flash 样本直接推断固定成本倍率。

Pro 两轮 usage 分别为输入/输出 8003/119 和 8429/73，来源明确为 `qoder_context_ratio+stream_token_deltas`，不是 Qoder 原生 token 账单。真实缓存字段仍缺失，当前服务不把前缀估计发成缓存命中。Credits 使用实际累计差分，与推导 token 分开记录。

复核已有测试无需发模型请求（会话 ID 与标记来自 `scripts/dsh-native-smoke.ts read qoder-deepseek-pro` 的输出）：

```powershell
node --import tsx scripts/verify-pro-native.ts <Pro 测试会话 ID> <标记>
node --import tsx scripts/status.ts
```
