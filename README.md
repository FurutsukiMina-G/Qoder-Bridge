# QoderBridge CN

通过 **Qoder CN 官方 Agent SDK** 提供 DeepSeek Flash 与 DeepSeek V4 Pro，并已作为自定义模型源接入本机 DeepSeek Harness。Flash 的原生 `read` / `grep` 和 Pro 的原生 `read` 端到端循环已通过；运行策略为 1M/max，不同 Harness 会话及不同模型的 Qoder 状态独立。参见 [接入指南](docs/deepseek-harness.md)、[Opus 改动复核与 Pro 验收](docs/opus-review-and-pro.md)和[1M/会话隔离核查](docs/context-and-isolation.md)。此前 Phase 0 / Phase 1 的实验记录保留在下文。

可以直接在 DeepSeek Harness 创建任务测试。新任务的轮次和 Qoder 用量会写入本机 `reports/tasks.ndjson`，并可用 `npm.cmd run tasks:report` 汇总；见 [日志说明](docs/task-logging.md)。

**仓库不含本机数据。** `reports/`（任务日志、遥测、审计与验收报告）、`.runtime/`（桥接密钥、Harness 本地会话凭据、SDK 工作目录与备份）和 `local/`（本机笔记与绑定真实会话的脚本）均被 `.gitignore` 排除；文档中出现的这些路径指本机生成的文件。首次 `serve` 会在 `.runtime/bridge-key` 随机生成本机密钥，Qoder 登录态由官方 CLI 保存在用户目录，均不进入仓库。

不用启动 Qoder CN 桌面端也可尝试查询账户余额：运行 `npm.cmd run balance`，它通过官方 SDK 的 `getUsageInfo()` 读取额度，不发模型请求。当前这台机器的 SDK 返回 `null`，余额因此未知；可运行 `npm.cmd run qoder:tui`，在官方 CLI 中输入 `/usage`，或登录 Qoder CN 官网查看 Settings > Usage。Bridge 本身也不依赖桌面端常驻。

Harness 已更新到官方桌面端 `0.2.0-rc.2`，Bridge 使用 `8646`。新版内置 pi-ai `0.87.1` 的 SSE、工具参数和用量兼容检查通过，实际 Pro `read` 与 Flash `pwsh` 均完成工具→结果→最终回复循环，原有会话和凭据保留。见 [2026-09-30 桌面升级验收](docs/desktop-update-20260930.md)。已实现 SDK 思考片段与规范 `final.content` 回答的即时 SSE 转发；工具参数仍在完整 Schema 校验后交付，非规范纯文字回答会在整轮结束后发送。流式与用量口径见 [更新、流式与用量](docs/update-and-streaming.md)。

2026-10-01 已修复实际出现的 DSML/DS 标记、字符串参数、引号、占位、调用包装/作用域及扁平工具 kind，并只合并同值重复参数；JSON 中的协议标记保持为数据，整批工具仍严格验证 Schema。九种真实格式异常重放及 77 项检查通过，原生 PowerShell 实测成功。长任务中 `error_max_turns` 的底层原因仍待后续日志确认；具体任务的中断排查记录只保存在本机。

Harness 已能显示推导的本轮 token 用量、tok/s 和上下文压力。SDK 的 token 字段仍全为 0，Bridge 使用 `context_usage_ratio × 策略窗口` 和 text/thinking delta 个数推导；既有受控 Flash 样本支持这一口径，但不是官方 token 计数保证，也未证明 Pro 的每个 delta 必定等于一个 token。缺任一信号或分块异常时不发送 usage。Qoder 不报告缓存命中，默认不发缓存字段（Harness 此时把全部输入标成「未缓存输入」）；`--cache-usage estimate` 可发送按会话前缀估算的缓存读取数，属估算值。详见[更新、流式与用量](docs/update-and-streaming.md#token-与缓存)；`npm.cmd run metrics` 汇总 token、tok/s、Credits、延迟与本地复用次数。

## 当前状态

- 已使用 `@qodercn-ai/qodercn-agent-sdk@1.0.50`，实测 runtime `1.1.64`。
- 相同 Harness 会话在两分钟内重试完全相同的已成功请求时复用结果，不再次调用模型；这是本地结果复用，不计为模型 token 缓存命中。
- 请求断开和总超时会终止其占用的 SDK 会话；排队取消不会中断其他正在执行的请求。计费缺失保持未知，不承诺取消后的上游退款。
- 已实现运行时模型发现、精确模型选择、参数验证、流式输出、请求级 Credits/Token/延迟报告。
- 已实现三种独立拦截实验：`canUseTool` 的 deny+interrupt；`PreToolUse` 的 stop+deny 和 defer。
- Phase 1 的测试工具只有假的 `read_file(path)`；当前 Harness 接入使用其自己的工具，Bridge 不执行文件或 shell 操作。
- 初次拦截通过后，自动在同一会话注入原生 `tool_result`，检查模型能否返回随机校验值。
- 本机已完成官方 CLI 授权，真实模型 ID 为 `dfmodel`，显示名为 `DeepSeek-Flash`。
- 真实文本推理和 JSON action 备用路径已跑通。原生工具 Gate 尚未通过：初步 permission/defer 实验有额外请求；hook stop 能停住，但产生自动错误结果和重复 tool result。
- 当前已支持用公开 `getSessionMessages()` 审计实验会话。详见 [STATUS.md](STATUS.md) 和 `reports/telemetry.ndjson`，不能把离线测试通过当作真实 Gate 通过。

## 安装与登录（PowerShell）

```powershell
git clone https://github.com/FurutsukiMina-G/Qoder-Bridge.git
cd Qoder-Bridge
npm.cmd ci
npm.cmd run qoder:login
npm.cmd run models
```

首次 `npm ci` 会由官方 SDK 下载运行时。已经安装好时，无需重复安装。
`qoder:login` 使用 SDK 官方 runtime 的 login 命令，在浏览器完成授权。SDK 通过公开的 `qodercliAuth()` 复用该登录态，不读取桌面端数据库或提取内部 token。

也可以在本机设置 `QODERCN_PERSONAL_ACCESS_TOKEN`，再指定 `--auth pat`。不要将密钥写进代码、报告或聊天。默认 `auto` 优先使用此环境变量，未设置时使用 CLI 登录态。国际版的 PAT 变量与 SDK 不适用于当前 CN 项目。

若 SDK 只报 `Transport closed`，先运行 `npm.cmd run qoder:models` 查看官方 CLI 的认证提示，再检查网络。需要代理时通过 `--proxy http://127.0.0.1:端口` 显式配置；SDK 不自动采用系统代理。

## Phase 0

```powershell
npm.cmd run models
npm.cmd run probe -- "只输出 OK" --json
# 若发现多个 DeepSeek Flash，使用 models 返回的完整 ID：
npm.cmd run probe -- "计算 17 * 23" --model "实际模型ID" --json
# 当前 CN 桌面端环境的显式会话隔离配置（不会修改全局设置）
npm.cmd run probe -- "只输出 OK" --json --session-settings config/thin-cn.json
```

不会假定 `deepseek-v4.1-flash` 是可用 ID。自动选择要求可用目录中唯一一个同时包含 DeepSeek 和 Flash 的模型；歧义或缺失时明确失败。`--model` 可显式选择目录里的其他模型用于排错，不会静默回退。

`--reasoning max`、`--context 1000000` 仅在目录元数据明确支持时接受；默认保留服务端默认值。

配置包含 `tools: []`、`skills: []`、`settingSources: []`、`plugins: []`、`strictMcpConfig: true`、字符串 system prompt、`maxTurns: 1`。`plugins: []` 仅表示不额外加载本地插件，不会自动关闭已有插件；程序在提交 prompt 前通过会话级 `applyFlagSettings` 尝试关闭发现的插件和 skills，记录结果到 `isolation`。可用 `--session-settings config/thin-cn.json` 在启动时关闭本机已发现的插件；实测该配置的 tools/skills/plugins 清单均为空。隔离工作目录是 `.runtime/`，不使用用户工程作为测试上下文。可以用 `--system-file 文件路径` 替换系统提示词。

SDK 的 `env` 会替换环境，代码必须显式保留 `...process.env` 后增加 request ID 开关。早期实验中的 `undefined/temp` 错误来自遗漏 Windows 环境变量，现已修复。日志保留了失败记录供追溯。

文本实时写到 stderr，JSON 报告写到 stdout；`--json` 关闭实时文本。每次调用向 `reports/telemetry.ndjson` 追加一行，可用 `--log 路径` 修改。报告不保存输入 prompt，但包含模型回复和拦截参数，因此仍应按私人实验数据保管。

## Phase 1

```powershell
npm.cmd run gate -- --path src/main.ts --strategy permission --json
npm.cmd run gate -- --path src/main.ts --strategy hook --json
npm.cmd run gate -- --path src/main.ts --strategy defer --json
```

三种策略分别测试，不把 hook 的成功当作 `canUseTool` 的成功。permission 策略中的 PreToolUse 只计数，不修改权限决策；没有预先 allow 测试工具。defer 使用公开的 defer 决策，仍保留拒绝执行的 callback 作为兜底；实测它会继续进入该 callback，不代表把执行交还宿主。若 runtime 自动批准而跳过 callback，惰性 handler 仅报告失败，Gate 不通过。

此实验刻意使用 `maxTurns: 3`，允许观察一次意外重试。若仍用 1，就可能把 maxTurns 强制结束错当成中断有效。策略回调允许最多两个模型决策，第三次明确失败，避免无限循环。除了 assistant 请求记录，还记录 policy 回调次数和 `api_retry` 事件。

`gate.interception_passed` 要求：完整工具名/参数、handler 从未进入、一次模型请求/策略回调、无 API retry、观察到正常终态、请求 Credits 可读取。缺失证据不会算通过。

`behavior_passed` 单独表示行为检查通过，不要求请求 Credits 可用。它通过后做第二轮：在同一个输入流、同一个 Qoder 会话中，以原 `tool_use_id` 注入随机字符串形式的工具结果。`continuation` 单独报告这次模型调用和费用。它不执行真实文件操作。Gate 实验打开会话持久化，仅用公开 SDK 读取本次实验会话的 runtime 历史，检查错误结果和重复 tool ID；薄推理仍不持久化。

**Phase 1 报告的 `phase2_ready` 仍为 false**，表示 Qoder 原生工具截获路径未通过。后续另行实现的 JSON 决策适配层已提供 OpenAI Chat Completions endpoint，并经 Harness 原生 `read` 工具验证；见 [接入指南](docs/deepseek-harness.md)。

退出码：0 表示 probe 成功或拦截子实验通过；1 表示配置/认证/运行错误；2 表示拦截子实验未通过。完整 Phase 1 是否完成应看报告字段，不能只看退出码。

## Telemetry 口径

| 字段 | 含义 |
|---|---|
| `startup_ms` | runtime 初始化和目录发现耗时 |
| `ttft_ms` | 提交 prompt 后首个可见文本耗时；不把 thinking 算文本 |
| `first_event_ms` | 首个 content delta，包括 thinking/tool JSON |
| `wall_ms` | 单轮从提交到终态的耗时，不含后续续接轮 |
| `total_wall_ms` | 本次命令含启动、清理及可能的续接实验 |
| `api_ms` / `sdk_wall_ms` | SDK Result 原样提供的 API/总耗时 |
| `model_requests` | 按 request_id / assistant message.id / uuid 去重的响应请求数；不等于后台网络请求的绝对计数 |
| `policy_calls` / `api_retries` | 调用前的模型策略计数 / SDK 重试事件 |
| `requests` | 每个响应的 Tokens、Credits、original_credits、billable |
| `total_session_credits` | Result 提供的会话累计 Credits，不能逐轮相加 |

缺失值保留 `null`，不会伪造零成本。请求 Credits 来自 assistant 或 stream usage，来源单独记录；累计 Credits 仍取 Result 的 `total_credits`，不取 Result 的 token usage。policy 回调发生于请求前，失败请求可能没有 assistant，所以独立保留两个计数。

当前 CN runtime 实测 Token 计数字段均为 0，但确实产生了输出，因此不能视作可信的零消耗。显式指定 `--context` 时，`normalized_usage` 改由 `context_usage_ratio × 窗口` 与流式 token delta 计数得出（`normalized_usage_source` 标明来源）；未指定窗口时分母未知，保持 `null`。新版流事件能报告请求 Credits；Bridge 优先使用累计差分，缺失时才回退到该请求值，避免相加重复。`continuation` 的累计 Credits 已包含第一轮，不能与外层累计值相加。

## Minimal Action Protocol 备用路径

```powershell
npm.cmd run action -- "Request reading src/main.ts from the host." --json --session-settings config/thin-cn.json
```

命令行备用协议实测返回 `{"action":"read_file","arguments":{"path":"src/main.ts"}}`。它只产生动作，不执行动作。单独的 HTTP 适配层把相同思路扩展为通用工具 Schema 与标准 `tool_calls`，已接入 Harness；两者的详细行为见 [接入指南](docs/deepseek-harness.md)。

## Benchmark

```powershell
# 默认只打印 20 短 + 10 推理 + 5 长输出的计划，不消耗 Credits
npm.cmd run benchmark
# 明确运行；可先限 1 条
npm.cmd run benchmark -- --run --limit 1 --model "实际模型ID"
npm.cmd run benchmark -- --run --model "实际模型ID"
```

当前 benchmark 只测薄推理，每条使用新 session，单独记录启动耗时；没有声称是常驻吞吐测试。原生 Qoder Agent 对照、任务质量评分、30% 时间/20% Credits 优化均尚未验证。请勿把离线通过或单条短请求当作性能结论。

## 开发和文件

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run report
node dist/src/main.js --help
```

`src/client.ts` 管理官方 SDK 探针；`src/pool.ts` 为 Harness 的并行会话复用独立 Qoder 会话；`src/compat.ts` 转换消息和工具定义；`src/server.ts` 提供本机 OpenAI Chat Completions API；`interceptor.ts` 保留早期原生拦截 Gate。`reports/bridge.ndjson` 记录每轮提示字符数、是否重复工具定义、延迟与 Credits 增量。

## 后续验证

1. 在更多任务上比较质量、耗时与 Credits；目前同类 `read` 任务已端到端通过，但 Credits 随运行出现波动。
2. 逐类验收其它 Harness 原生工具，尤其是 Shell、编辑、搜索与子代理。
3. 扩大流式与取消后的真实任务验证；跨进程会话恢复和非规范纯文本增量投影仍未启用。

## 官方参考

- [Qoder CN SDK 认证](https://docs.qoder.cn/cli/sdk/authentication)
- [TypeScript SDK Reference](https://docs.qoder.cn/cli/sdk/references-typescript)
- [模型选择](https://docs.qoder.cn/cli/sdk/model-policy)
- [工具](https://docs.qoder.cn/cli/sdk/tools)
- [用户原始方案](docs/design.md)

本项目仅做私人本地实验，只调用官方 SDK/CLI，正常使用账户 Credits。
