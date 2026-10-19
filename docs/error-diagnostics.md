# DSH 中的中断错误来源

Bridge 在 OpenAI 兼容 HTTP 错误和流式 `error` 事件的 `error.message` 中直接放入中文来源、原因、建议、稳定错误码和请求 ID。DSH 0.2.1-rc.2 的 pi-ai 1.1.0 会保留这段正文，因此不依赖 DSH 展示自定义 JSON 字段。已发送的正文不会因错误被改写，也不会补发成功终止或工具批次。

| 显示来源 | 可据以判断的证据 |
| --- | --- |
| `[账号]` | SDK 明确的每日上限、试用/免费用户限制、各类积分不足、认证错误；每日上限不代表积分余额归零 |
| `[Bridge]` | 本地记录/交付异常、Bridge 总时限、推理预算与流式一致性保护 |
| `[模型输出/协议]` | 模型输出不符合 DSH/Bridge 工具契约，有界纠正停止；这是协议不匹配的证据，不直接认定某个程序有 bug |
| `[上游服务/SDK]` | SDK 明确的服务错误、输出预算、SDK 轮数限制、请求/网络错误；含糊的网络错误不归咎模型本身 |
| `[DSH/客户端请求]` | 请求、模型、schema、接口或本地 Bridge 密钥不合要求；本地密钥错误与 Qoder 账号认证分开 |
| `[连接/客户端中断]` | 客户端断开或 SDK 取消；可能由用户操作、客户端退出或连接问题触发，不能直接判定 DSH bug |
| `[来源未确定]` | 现有证据不足，不猜测来源 |

示例：

```text
[账号] Qoder 账号达到每日用量上限（daily usage limit）；不等同于积分余额耗尽。
建议：检查 Qoder 账号的套餐、对应额度或登录状态；条件恢复后再继续，不要反复重试。
错误码：upstream_daily_limit | SDK错误码：110 | 请求ID：<本次请求 UUID>
```

只有 SDK 实际提供 `result.error_code`（或异常携带的 `result.error_code`）才显示 SDK 错误码。仅收到每日上限文字时不补填 `110`。SDK 结果码、异常机器码和 CLI 进程退出码保存在不同字段，不能互相解释。分类按[官方 SDK 错误文档](https://docs.qoder.cn/en/cli/sdk/errors)与本地 SDK 类型实现；未知码原样保留为有界标识符，不猜含义。

除正文外，错误对象包含 `origin`、`evidence`、`phase`、`sdk_error_code`、`sdk_exception`、`request_id`；响应头包含 `x-qoderbridge-request-id`。客户端 SDK 的整次 HTTP 自动重试通过 `x-should-retry: false` 禁止，Bridge 既有同请求有界纠错不变。`automatic_retry: false` 指这次错误返回后不应自动重新开始；已发生的内部纠错次数仍在 `decision_recovery`。公共纠错摘要只给次数、阶段和哈希，不复制可能包含参数、命令或私人内容的原始校验错误。

所有错误（包括预检与断开）写入 `reports/errors.ndjson`；存在模型报告时，同一 ID 的 `reports/bridge.ndjson` 和 `reports/tasks.ndjson` 也包含诊断。新诊断日志没有单独计入模型用量，不能把一条错误日志再次算成一次模型调用。SDK 原始失败与完整纠错证据仍在原有本地记录中。不要公开整份原始记录。

Bridge 没有启动、HTTP 根本未到达 Bridge、DSH 自己崩溃或其本地工具报错时，Bridge 无法生成或送达诊断，仍需 DSH 本地错误与日志。已经断开的连接同样只能留下 Bridge 日志，不能保证在已关闭的 DSH 窗口里显示。此改动不修改 DSH 安装文件，不批准权限，也不解除账号限制。

`scripts/error-adapter-smoke.ts` 使用本地注入结果检查已安装适配器的 8 类错误；不调用 Qoder 模型、不启动 DSH 任务、不运行应用项目或 GUI 测试。运行时可指定 DSH 包根目录与报告路径；ASAR 安装包需用 Electron 的纯 Node 模式读取。
