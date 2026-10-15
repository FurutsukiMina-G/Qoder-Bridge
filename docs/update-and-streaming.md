# 2026-09-27 更新与优化核查

2026-09-30 已进一步升级到官方桌面端 `0.2.0-rc.2`，旧程序目录和旧安装器已清理，工作数据及数据备份保留。最新验证见 [桌面升级验收](desktop-update-20260930.md)；本页记录首次升级与流式实现的历史。

已将旧桌面壳 0.3.20（内置 Harness 0.1.5-rc.1）更新为 DeepSeek 官方 Windows `0.1.7-rc.2`。安装包来自官方 production 更新源，大小 288245480 字节，SHA-512 与 feed 一致，Authenticode 签名为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.。旧安装登记不被新安装器识别，因此保留旧目录并在原路径安装；没有修改安装器或绕过校验。

回退材料保存在 `D:\DSH\DeepSeek Harness-legacy-0.3.20` 与项目 `.runtime/update-backup-20260926`。后者含用户配置/凭据备份，不应公开。新版使用 `~/.dsh/profiles/desktop` 和本机 19387 端口；原会话、QoderBridge 凭据引用、默认模型和 1M 配置已保留。RPC 脚本已支持新旧启动日志和经 Host 正常签发的本地 Cookie，认证信息只保存在忽略的 `.runtime` 中。

## 流式输出

SDK 升至 `1.0.50`，实测 runtime `1.1.64`。上游 `thinking_delta` 实时映射为 OpenAI `reasoning_content`；规范 `{"kind":"final","content":"..."}` 的正文会增量解码后发送，处理跨块转义与 Unicode。首个可见文本和思考延迟均记录在任务日志，不将 role 帧或 keepalive 注释算作首个模型文字。

工具名和参数必须完整收齐、通过工具 Schema 校验后才发送 `tool_calls`；模型坏输出以标准 SSE error 结束，不发送虚假的 stop。更新版 Harness 实际采用的 pi-ai/OpenAI 适配器已通过离线错误流/usage fixture 验证。非规范纯文本仍在终态后发送，不能宣称所有输出形状都能即时投影。

真实流式探针：594 字符回答，首思考约 1.480 秒、首正文约 1.937 秒、整轮约 3.622 秒；收到 152 个正文块、74 个思考块。完全相同请求再次提交约 6.3 毫秒返回，日志确认模型调用数 0、Credits 增量 0。这是一次短请求测量，不代表长期吞吐率。

## 成本与可靠性

- 同一会话两分钟内的相同成功请求（含模型、完整消息、工具、tool_choice、输出参数）本地复用结果。新用户消息、工具结果、工具 Schema 或参数变化均重新推理；本地复用不是 Qoder token 缓存。
- 同一 Harness 会话并发的首次请求共享初始化，然后按会话串行处理，避免并发网络重试开出多个 Qoder 会话。
- 队列取消不打断正在执行的其他请求；客户端断开或总期限到达，会关闭该请求拥有的 Qoder 会话。不能承诺上游对已生成内容退款，未收到用量时保留未知。
- SDK 失败终态现也保留可获取的用量/响应记录；Credits 优先累计差分，无累计数时使用明确报告的 stream/assistant 请求 Credits，记录来源并避免重复相加。
- 修正零条新增消息被 `slice(-0)` 误记为全量历史的日志问题，发送工具定义字符数改为实际压缩内容长度。操作脚本统一为 8646。

## token 与缓存

Result 和所有 stream usage 的 input/output/cache 字段仍全为 0（transcript 中同样为 0，runtime 状态文件加密，未尝试读取）。Bridge 根据 runtime 的两个信号推导用量。以下语义来自既有受控 Flash 样本，尚不是 SDK 的官方计数保证；尤其 delta 粒度可能随模型/runtime 改变，Pro 尚未独立完成 token 精度校准：

- **输入 token** = `context_usage_ratio × 本次策略窗口`。该比值是「本次请求输入 token ÷ 窗口」：1M 窗口下为最多 6 位小数的整数/1e6；1.1.61 时代未指定窗口时分母为 180000（整数/180000）。它只含本次请求的输入，不含本次输出，也不保留历史轮次的推理内容。
- **输出 token** = 流式 `text_delta` 个数 + `thinking_delta` 个数，推理数另报为 `completion_tokens_details.reasoning_tokens`。既有样本符合每个 delta 一个 token 的假设（例如 `"1"," ","2"`、`" user"," wants"`），分块启发式只能筛掉明显异常，不能证明所有请求都满足这一假设。

受控验证（2026-09-27，单个 1M/max 会话四轮，约 0.18 Credits）：输入依次为 158 → 173 → 200 → 513 token。第 1、2、4 轮提示相同，第 3 轮流出 299 个正文 delta 和 455 个推理 delta。(513−200) − (173−158) = 298 = 299 − 1，恰等于第 3 轮与第 1 轮答复（「OK」为 1 个 token）的 token 差；455 个推理 token 没有进入下一轮上下文。`getContextUsage()` 只给 0.1% 精度的本地估计，不可用。

发送规则：仅当 Bridge 自己的模型策略指定了窗口（serve 模式固定 1M）、每个响应都带比值、正文全部经流式 delta 到达，且分块像逐 token（单块 ≤256 字符，≥32 块时平均 ≤12 字符/块，没有其他 delta 类型）时，才发送推导的 `usage`；任一条件不满足则不发送，不额外按字符猜测。本地重放没有模型调用，发送 0 用量。

Harness 端到端（原生 read 测试会话）：此前 Harness 为每步记录 `inputTokens/outputTokens = 0`，现为 7,904/116 与 8,322/67；会话 `contextPressure` 按真实 Qoder 上下文 8,322/1,000,000 计算，自动压缩阈值随之以真实 token 生效；`sessionStats` 为 183 个解码 token / 3,055 ms（约 60 tok/s）。当前 Harness 的 pi-ai 适配器不映射 `reasoning_tokens`，因此「其中推理」一栏不显示。

**缓存命中无法计量。** Qoder 不返回缓存字段，官方用量文档说明 token 与 Credits 之间没有固定换算，用 Credits 反推的线性拟合也不自洽，所以默认不发送缓存字段。此时 Harness 会把全部输入标为「未缓存输入」，这只是其界面标签，实际缓存状态未知；从 Credits 看，长会话续接轮的大部分前缀确实命中了缓存。

`--cache-usage estimate`（或环境变量 `QODERBRIDGE_CACHE_USAGE=estimate`）发送会话前缀估算：同一 Qoder 会话里，上一请求的全部输入是本请求的精确前缀，因此估算缓存读取数 = 上一请求输入 token（向下取整到 DeepSeek 的 64 token 缓存单位）。新会话首轮一律按 0 估算，看不到重启后同一历史前缀的跨会话命中，也看不到缓存淘汰。无论是否开启，估算值都写入日志的 `cache_estimate_tokens`，真实缓存状态保持 `not_reported_by_qoder`。

`npm.cmd run metrics` 汇总输入/输出/推理 token、中位 tok/s、Credits、延迟、本地重放数和前缀估算比例。

## 会话池与测试隔离（同日）

- 空闲 20 分钟的 Qoder 会话由每分钟一次的后台清扫释放；此前只在打开新会话时才回收。
- 同一 Harness 会话键出现分支、回滚或压缩后的新历史时，旧 Qoder 会话已不可路由，立即关闭（忙碌中的留给清扫）。
- 启动预热失败（如登录时网络未就绪）不再使服务退出：等待首次预热尝试成功或失败后监听端口，按需打开会话，并每分钟重试预热；`/health` 显示 `prewarm_error`。当前并非先监听再预热。
- 测试不再向真实 `reports/*.ndjson` 追加 `bridge_port: 0` 的 fixture 记录（`createBridgeServer` 支持 `reportDir`）。

## 验证与边界

42 项自动检查和构建均通过。官方更新后基线 read 测试，以及流式版并行 read/grep 测试均完成原生工具→结果→最终标记循环，零错误、会话独立。新流式版 read 最终答复首正文约 1.525 秒，grep 约 1.372 秒。升级基线、两个流式原生工具会话和直接 SSE 探针合计约 **0.472057 Credits**，详见 `reports/upgrade-validation.json`、`reports/streaming-smoke.json` 和 `reports/adapter-smoke.json`。后者的 token/cache 数据是测试 fixture，不是账户实际用量。

当前仍仅支持文本输入，图片会在调用模型前以 400 拒绝。上游 SDK 没有在当前适配路径暴露每次请求的 temperature/max_tokens 映射；Harness 的这类参数不应被视为已在 Qoder 执行。1M/max 仍是模型策略配置，不等于完成过 1M 占满测试。跨进程持久恢复 Qoder 会话尚未启用；重启后仍需重发 Harness 历史，避免未验证的恢复造成分支或会话污染。

官方参考：[Harness 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)、[桌面打包与更新](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)、[SDK 流式事件](https://docs.qoder.cn/en/cli/sdk/streaming-output)、[SDK 用量口径](https://docs.qoder.cn/en/cli/sdk/cost-usage)。
