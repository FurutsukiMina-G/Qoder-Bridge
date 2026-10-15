# DeepSeek Harness 接入与验收

已在本机运行的官方 DeepSeek Harness Desktop `0.2.0-rc.2` 配置自定义模型源；本次更新后的 Pro `read`、Flash `pwsh`、SSE 与用量验证见 [桌面升级验收](desktop-update-20260930.md)：

| 项目 | 值 |
|---|---|
| Provider | `qoderbridge` |
| Flash | `qoder-deepseek-flash` → Qoder CN `dfmodel` |
| Pro | `qoder-deepseek-pro` → Qoder CN `dmodel`（DeepSeek-V4-Pro） |
| API | `openai-completions` |
| Base URL | `http://127.0.0.1:8646/v1` |
| 凭据引用 | `QODERBRIDGE_LOCAL_KEY`；随机密钥位于本项目 `.runtime/bridge-key`，由 Harness 凭据服务保存副本 |
| 输入类型 | text |
| 上下文 | Harness 1M；Bridge 每次请求向 Qoder 指定 1M/max |
| 工作模式 | Qoder SDK 返回 JSON 决策 → Bridge 校验并转换为 `tool_calls` → Harness 执行原生工具 |

Harness 当前模型目录中已出现该 Provider 的两个模型，可选择 `Qoder DeepSeek Flash` 或 `Qoder DeepSeek V4 Pro`。注册脚本只补充缺少的模型，保留已有模型设置，不批量改写会话选择。当前默认选择可用 `npm.cmd run status` 查看。Provider 和凭据通过 Harness 自带的 Settings/Remote API 写入，修改前的非敏感配置快照保存在 `reports/dsh-settings-before.json`。桥接密钥不进入源码、日志或这个文档。

两种模型共用 8646 API，分别持有 Qoder 会话池、工具目录缓存、Credits 差分和本地重放状态；同一 Harness 会话切换模型不会误用另一模型的历史。Pro 不可用时明确报错，不静默替换成 Flash。启动默认只预热 Flash，Pro 第一次使用按需初始化；两者合计最多 3 个活动请求。完整验收见 [Opus 改动复核与 Pro](opus-review-and-pro.md)。

1M 能否启动、两条并行 Harness 会话是否隔离的专门核查见 [1M 上下文与会话隔离](context-and-isolation.md)。

Bridge 仅监听 `127.0.0.1:8646`，需要 Bearer 密钥。`GET /health` 返回后台服务、并发/排队计数和能力；`GET /v1/models` 和 `POST /v1/chat/completions` 需要认证。当前由 Windows 计划任务 `QoderBridge-8646` 独立运行，在登录后启动。旧 8642–8645 服务已退出。`npm.cmd run status` 从实时健康接口读取 PID。

从项目目录重新启动或停止服务：

```powershell
cd D:\GPT-work\qoderbridge
npm.cmd run build
& .\scripts\start-server.ps1
Invoke-RestMethod http://127.0.0.1:8646/health
npm.cmd run status
& .\scripts\stop-server.ps1
```

`start-server.ps1` / `stop-server.ps1` 会优先控制已经注册的同名计划任务，并核对任务工作目录。登录态由官方 Qoder CN CLI 提供，失效时在本项目目录运行 `npm.cmd run qoder:login`。服务启动时预热一个 Qoder SDK 会话，首次预热大约需要几十秒；会话使用后后台补足一个预热会话。服务可随 Harness 请求并行处理不同会话，每个会话各自保持模型历史与计费状态。

## 原生工具实测

在独立目录 `.runtime/dsh-native-test` 写入随机哨兵文件，调用 Harness 官方 `session/create`、`session/selectModel`、`session/prompt` 接口。测试会话记录：

- 旧版每轮新启动 Qoder：`tool/call` 是 Harness 原生 `read`，`tool/result` 含随机文件标记，最终答案完全匹配；Harness 记录的模型总耗时约 125 秒。
- 按会话复用 Qoder：同样有 Harness 原生 `read` 与工具结果，最终答案匹配；Harness 记录的模型总耗时约 42 秒。第二步 Bridge 记录 `reused_session=true`，Qoder 模型轮次约 2.9 秒。
- 服务移入计划任务后，省略续接轮重复工具定义：原生 `read` 与答案继续通过，Harness 记录模型耗时约 7.9 秒。
- 缩短长工具说明后：两次原生读取均通过，Harness 记录分别约 9.5 秒、9.3 秒。
- 原生 `grep`：搜索哨兵文件，`tool/call` 与 `tool/result` 均存在，最终答案匹配。Qoder 两轮累计约 0.033 Credits；首轮模型 API 约 4.4 秒，但 Bridge 等待约 39 秒，存在明显非模型延迟波动。

Harness 实际在请求中提供了 27 个原生工具定义，Bridge 向 Qoder 提供这些工具的名称、说明和 JSON Schema，并且只接受名称与参数满足本次请求的工具决策。已实测 `read` 和 `grep` 均由 Harness 自己执行并回传结果；其它工具走同一通用映射，但尚未逐一进行端到端验收。Bridge 本身不执行文件、shell 或网络工具。

重复可运行：

```powershell
node --import tsx scripts/dsh-native-smoke.ts
node --import tsx scripts/dsh-native-smoke.ts grep
node --import tsx scripts/dsh-native-smoke.ts read qoder-deepseek-pro
node --import tsx scripts/dsh-inspect-session.ts <上一步输出的 sessionId>
node --import tsx scripts/dsh-session-page.ts <上一步输出的 sessionId>
```

`session/page` 的 `tool/call`、`tool/result` 和 `assistant/message` 是工具执行与答案的独立证据。`reports/bridge.ndjson` 记录 Qoder 模型轮次、是否复用会话、API 与总延迟、会话累计和每轮增量 Credits。

真实任务采集与按会话汇总的字段、命令和文本截断策略见 [实际任务日志](task-logging.md)。

## 上下文与额度优化

Bridge 首次给模型提供 27 个 Harness 工具名称与参数 Schema；同一 Qoder 会话里如工具定义未变，续接轮只告知“沿用上一轮工具目录”，不重复发送约 2.97 万字符的工具定义。Harness 实测首轮 Bridge 提示约 36,809 字符，续接轮降为约 1,021 字符，原生 `read` 仍成功。首次工具目录的长说明另做有界缩短，保留工具名、参数名、required、枚举、结构及原始 Schema 校验，首轮提示降至约 27,269 字符。原生 `grep` 的续接提示实测约 932 字符。

费用按同一会话累计 Credits 的相邻 Result 差值记录。此前完整工具定义的单个原生读取任务记录约 0.171 Credits；省略续接重复定义后的同类任务约 0.033 Credits。说明缩短后的两次任务分别约 0.157、0.038 Credits，其中第一次首轮约 0.138、第二次首轮约 0.018；说明 Qoder 侧的缓存或计费有明显波动。因此不能将字符数变化换算为固定节省比例，需要更大样本。已确认的是续接轮没有再发送重复工具目录、任务质量未受这几次测试影响；费用改善幅度仍待更多样本验证。

## 协议边界

- 这是显式的 JSON 决策转 `tool_calls`，不是 Qoder 原生工具调用。之前的 Qoder native interception Gate 失败，未作为 Harness 模型源使用。
- 每次 Harness 请求都包含完整会话消息与工具定义。Bridge 对同一工具调用链复用 Qoder 会话；不同并行会话各有独立 Qoder 会话。对话前缀发生分支或回滚时创建新 Qoder 会话，避免旧历史污染。
- `stream: true` 实时发送 SDK 思考片段和规范 final JSON 的正文，保留转义和 Unicode；工具调用完整校验后发送。多工具调用使用独立索引；客户端取消和总超时会关闭当前 SDK 会话。
- 当前只接收文本消息；模型在 Harness 中声明为 text。图片请求会被拒绝。
- SDK 自带的 Token/缓存字段仍为不可靠的零；Bridge 改用 `context_usage_ratio × 1M` 计输入、流式 token delta 计输出/推理，并以标准 `usage` 发给 Harness（本轮用量、tok/s、上下文压力）。缓存命中上游不报告，默认不发送，可选会话前缀估算。Credits 优先取会话累计差分，缺失时才使用 stream/assistant 中明确报告的请求 Credits，并记录来源；不会把两种口径相加。详见 [本次升级核查](update-and-streaming.md#token-与缓存)。
- 更短的提示并未消除所有耗时波动：一次 `grep` 首轮的模型 API 约 4.4 秒，但 Bridge 等到 Qoder 完整 Result 用了约 39 秒；这些相隔的时间不能归因为模型本身。
- `dfmodel` 当前展示名为 `DeepSeek-Flash`；运行时目录没有确认精确的 V4.1 版本号。

官方 Harness 自定义 Provider 指南：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。
