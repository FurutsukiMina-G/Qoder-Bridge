# QoderBridge：将 Qoder 作为低成本 DeepSeek 模型源的外部 Harness 接入方案

**状态：Technical Design / PoC Specification**  
**目标模型：DeepSeek V4.1 Flash（以 Qoder 运行时实际 Model ID 为准）**  
**目标 Harness：DeepSeek Harness，后续兼容 OpenCode**  
**建议实现语言：TypeScript**  
**日期：2026-09-23**

---

# 1. 项目目标

本项目试图解决以下问题：

Qoder 提供的 DeepSeek 等模型成本明显低于直接使用官方 API，但 Qoder 自身 Agent Harness 在实际使用中存在明显的时间效率和调用效率问题。

目标是将架构由：

```text
User
  ↓
Qoder Agent
  ↓
Qoder planning / tools / verification / agent loop
  ↓
DeepSeek V4.1 Flash
```

改造成：

```text
DeepSeek Harness / OpenCode / Minimal Harness
                  ↓
             QoderBridge
                  ↓
        Qoder Agent SDK
       （尽可能薄化）
                  ↓
        DeepSeek V4.1 Flash
                  ↓
           Qoder Credits
```

核心原则：

**Qoder 尽量只承担模型访问与计费功能。**

Agent planning、文件操作、shell、搜索、工具循环、停止判断等功能，应尽可能交给外部 Harness。

---

# 2. 可行性结论

经过重新核查，方案应拆成三个层级。

| 能力 | 状态 | 结论 |
|---|---|---|
| Qoder SDK作为低成本模型入口 | ✅ 已确认 | 可实现 |
| 去除 Qoder 内置工具 | ✅ 已确认 | `tools: []` |
| 禁用 Skills | ✅ 已确认 | `skills: []` |
| 禁止项目/用户指令自动加载 | ✅ 已确认 | `settingSources: []` |
| 替换 Qoder system prompt | ✅ 已确认 | 直接传字符串 `systemPrompt` |
| 固定模型 | ✅ 已确认 | 可通过完整 Model ID / runtime model list |
| 固定 reasoning/context | ✅ 已确认 | SDK Model Policy 支持 |
| 限制 Agent turns | ✅ 已确认 | `maxTurns` |
| Qoder流式输出 | ✅ 已确认 | text / thinking / tool JSON delta |
| 获取每次模型调用 Credits | ✅ 已确认 | SDK usage API |
| 中断运行中的 Agent | ✅ 已确认 | `interrupt()` |
| 自定义 native tools | ✅ 已确认 | SDK in-process MCP |
| 捕获 tool call 后阻止 Qoder继续循环 | ⚠️ 需 PoC | API组件均存在，但组合行为需验证 |
| 完整模拟 OpenAI tool-calling API | ⚠️ 需 PoC | 取决于上一项 |
| DeepSeek Harness透明接入 | ⚠️ 第二阶段 | Provider端支持没有问题，Bridge端需先验证 |
| OpenCode透明接入 | ⚠️ 第二阶段 | 同上 |

Qoder 官方 SDK 明确允许 host application、脚本和自动化通过 PAT、本地登录状态等方式创建 session。

更关键的是，SDK 可以显式设置：

```text
tools: []
skills: []
settingSources: []
systemPrompt: "..."
```

其中：

- `tools: []` 会让模型完全看不到 Qoder 内置工具；
- `skills: []` 禁用所有 Skill；
- `settingSources: []` 禁止加载 user/project/local instructions；
- 字符串形式 `systemPrompt` 会直接替换 Qoder CLI preset，而不是追加内容。

因此，“将 Qoder Agent 大量削薄”不是 hack，而是官方 SDK 明确提供的能力。

---

# 3. 一个重要修正

早期方案里不能直接假定：

```text
Qoder SDK
→ native tool call
→ 截获
→ 原样返回 DSH
```

一定能够稳定工作。

原因是 Qoder 的标准 Agent Loop 是：

```text
LLM
 ↓
tool call
 ↓
qodercli 执行工具
 ↓
tool result
 ↓
再次 LLM request
```

官方文档明确说明工具结果会重新加入 conversation，然后模型获得下一轮推理机会。

因此真正的关键实验不是“Qoder能不能自定义工具”，这个已经确认。

真正需要验证的是：

> **模型产生 tool call 后，能否截获 tool name + arguments，并在工具真正执行或结果进入下一轮模型之前中止当前 Qoder turn。**

好消息是 SDK 已经具备所需组件：

- `canUseTool` 能在工具执行前得到 `toolName` 和 `input`；
- deny 时支持 `interrupt: true`；
- `q.interrupt()` 可以停止当前 generation/tool execution；
- streaming events 可以得到 `input_json_delta`；
- SDK支持自定义 MCP tools。

所以技术条件是存在的，只是需要实际验证组合后的行为。

这就是本项目最重要的 **PoC Gate**。

---

# 4. 推荐总体架构

最终目标：

```text
┌──────────────────────────────────────┐
│          DeepSeek Harness             │
│                                      │
│ planning / context / tools / loop    │
└──────────────────┬───────────────────┘
                   │
         OpenAI-compatible API
                   │
                   ▼
┌──────────────────────────────────────┐
│             QoderBridge               │
│                                      │
│ message mapping                      │
│ model selection                      │
│ tool schema translation              │
│ tool-call interception               │
│ usage / latency telemetry            │
└──────────────────┬───────────────────┘
                   │
             Qoder SDK
                   │
                   ▼
┌──────────────────────────────────────┐
│        Minimal Qoder Session          │
│                                      │
│ tools = [] / controlled MCP only     │
│ skills = []                          │
│ settingSources = []                  │
│ custom systemPrompt                  │
│ no Qoder Agent behavior preset       │
└──────────────────┬───────────────────┘
                   │
                   ▼
            Qoder Model Service
                   │
                   ▼
        DeepSeek V4.1 Flash
```

DeepSeek Harness 本身已经支持自定义 provider，协议包括：

```text
openai-completions
openai-responses
anthropic-messages
```

因此只要 Bridge 最终能够提供标准 Chat Completions 或 Responses endpoint，DSH 端不需要修改核心 Agent。

OpenCode 同样原生允许：

```text
@ai-sdk/openai-compatible
+
custom baseURL
```

所以同一个 Bridge 理论上也可以服务 OpenCode。

---

# 5. 不要一开始实现 OpenAI Proxy

项目必须按照以下顺序开发。

## Phase 0 — Qoder Thin Inference Probe

这是整个项目最重要的一步。

先完全不做 DSH。

创建一个最简单的程序：

```text
prompt
 ↓
Qoder SDK
 ↓
DeepSeek
 ↓
text response
```

配置：

```ts
{
    tools: [],
    skills: [],
    settingSources: [],
    systemPrompt: MINIMAL_SYSTEM_PROMPT,
    maxTurns: 1
}
```

模型不能硬编码：

```text
deepseek-v4.1-flash
```

程序启动后应调用：

```text
getAvailableModels()
```

读取当前账户真实可用的 Model ID，再选择 DeepSeek Flash。

Qoder SDK 明确允许直接指定 backend 当前支持的完整 Model ID，并允许动态获取 available models。

### Phase 0 必须记录

每次调用记录：

```text
model
reasoning effort
context window

TTFT
model API duration
wall-clock duration

input tokens
output tokens

number of Assistant/model-request messages

credits
original_credits
billable
total_credits
```

Qoder SDK 已经直接暴露 request-level Credits 和 session-level Credits，无需自行估算。

Qoder CLI 本身也区分：

```text
Total Duration API
Total Duration wall
```

因此后续可以区分：

**模型本身慢**

和

**Qoder Harness overhead 慢**。

---

# 6. Phase 0 验收标准

运行至少：

```text
20 个短请求
10 个中等推理请求
5 个长输出请求
```

与正常 Qoder Agent 对照。

主要计算：

```text
Thin Bridge wall time / Qoder Agent wall time

Thin Bridge credits / Qoder Agent credits

Thin Bridge model-call count / Qoder Agent model-call count
```

如果 Thin 模式仍然和正常 Qoder 一样慢，则说明主要瓶颈可能在：

```text
Qoder model gateway
或
模型供应链
```

项目价值显著降低。

如果 Thin 模式明显更快，则可以确认：

> Qoder 默认 Agent Harness 才是主要性能损耗来源。

这时继续 Phase 1。

---

# 7. Phase 1 — Native Tool-Call Interception PoC

这一阶段不接 DSH。

只创建三个测试工具：

```text
read_file(path)
run_command(command)
finish(message)
```

这些工具使用 Qoder SDK 的 in-process MCP 功能注册。

模型能够看到真实 JSON tool schema。Qoder官方明确支持应用程序自行定义工具并通过 SDK 内置 MCP server 暴露给模型。

但工具 handler **不应该真正执行操作**。

Bridge需要尝试：

```text
model emits tool call
        ↓
canUseTool(toolName, input)
        ↓
capture toolName/input/toolUseID
        ↓
deny + interrupt
        ↓
return captured call to host program
```

理论路径：

```ts
canUseTool(toolName, input, context) {
    capturedCall = {
        name: toolName,
        arguments: input
    }

    return {
        behavior: "deny",
        message: "Tool execution delegated to host harness.",
        toolUseID: context.toolUseID,
        interrupt: true
    }
}
```

注意：

**这段只是实现方向，不是已经验证过的最终代码。**

---

# 8. Phase 1 必须验证的五件事

实验必须回答：

### A. 能否可靠捕获 tool name？

例如：

```text
read_file
```

### B. 能否可靠获取完整 arguments？

例如：

```json
{
  "path": "src/main.ts"
}
```

SDK streaming events 已明确支持 `input_json_delta`。

### C. interrupt 后是否还会产生第二次模型调用？

这是最关键指标。

目标：

```text
1 tool decision
=
1 model request
```

禁止：

```text
model
→ captured tool
→ denial result
→ model retry
```

### D. interrupted session 是否还能安全继续？

如果使用长连接 session：

```text
Tool call #1
→ interrupt
→ host执行
→ host提交 tool result
→ model call #2
```

需要确认 session state 没有被 Qoder的 deny/error 信息污染。

### E. Credits 是否只计算一次模型请求？

SDK message stream中的 request-level Credits 可直接验证。

---

# 9. Phase 1 Gate

只有满足：

```text
tool call可以截获
+
没有额外模型 retry
+
session可以继续
+
tool arguments完整
```

才进入 Phase 2。

如果失败：

**不要继续实现透明 OpenAI Provider。**

改用备用架构。

---

# 10. 备用架构：Minimal Action Protocol

如果 native tool interception 无法稳定工作，仍然可以使用 Qoder 作为模型源。

让模型输出：

```json
{
  "action": "read_file",
  "arguments": {
    "path": "src/main.ts"
  }
}
```

外层 Minimal Harness负责解析并执行。

例如：

```text
DeepSeek
 ↓
JSON action
 ↓
Bridge runtime
 ↓
read_file
 ↓
result加入下一轮 prompt
```

这种方案：

```text
Qoder tools = []
```

因此 Qoder完全不执行 Agent loop。

缺点是：

**模型使用的是文本结构化调用，而不是 native tool calling。**

这可能造成一定性能损失。

因此它适合作为 fallback，而不是首选最终方案。

---

# 11. Phase 2 — OpenAI-Compatible Bridge

只有 Phase 1 通过后实现。

第一版只实现：

```text
GET  /v1/models

POST /v1/chat/completions
```

不要同时实现 Responses API。

请求：

```json
{
  "model": "deepseek-v4.1-flash-qoder",
  "messages": [],
  "tools": [],
  "tool_choice": "auto",
  "stream": true
}
```

Bridge负责：

```text
OpenAI messages
        ↓
Qoder session representation

OpenAI tools
        ↓
Qoder custom MCP tools

Qoder text
        ↓
assistant content

Qoder tool call
        ↓
assistant.tool_calls
```

---

# 12. 最大技术难点：Conversation Mapping

不能简单把：

```text
system
user
assistant
tool
user
assistant
```

全部拼成一个巨大 user prompt。

这样虽然能工作，却会破坏不同 role 的语义，并可能影响 DeepSeek Agent能力。

优先设计应为：

```text
一个外部 Harness conversation
↔
一个 Qoder SDK session
```

Bridge维护：

```text
bridge_session_id
external conversation fingerprint
qoder session id
last synchronized message index
```

外部 Harness 每次请求都会重发 messages。

Bridge应找出：

```text
common prefix
```

只向现有 Qoder session追加新增内容。

如果 conversation发生：

```text
branch
rollback
context rewrite
```

则创建新的 Qoder session。

---

# 13. 并发设计

禁止全局单 session。

需要：

```text
SessionManager
```

结构：

```text
Map<ConversationKey, QoderSession>
```

每个 session必须：

```text
独立 conversation
独立 usage
独立 interrupt state
独立 tool-call state
```

不同 DSH subagent / parallel task之间不能共享 conversation。

---

# 14. 推荐 Minimal Qoder 配置

目标是尽可能接近“裸模型”。

建议：

```ts
{
  tools: [],
  skills: [],
  settingSources: [],
  plugins: [],
  systemPrompt: externalSystemPrompt,
  maxTurns: 1,
  includePartialMessages: true
}
```

SDK本身甚至默认禁用了 Qoder CLI factory built-in skills，因此通过 SDK运行已经比普通 CLI更容易构造干净环境。

另外应该避免：

```text
preset: qodercli
```

因为官方说明该 preset 本身包含：

```text
tool-use discipline
planning behavior
output conventions
```

这正是本项目试图绕开的 harness 行为。

---

# 15. 模型参数

不要写死模型名称和参数。

启动阶段：

```text
getAvailableModels()
```

选择：

```text
DeepSeek Flash
```

然后读取：

```text
context_config
thinking_config
```

在支持时设：

```text
contextWindow = 1M
reasoningEffort = max
```

Qoder SDK Model Policy 支持针对每次 LLM request指定：

```text
contextWindow
reasoningEffort
```

而当前 Qoder模型文档显示 DeepSeek Flash支持：

```text
200K / 400K / 1M
low / high / max
```

并且当前 credit factor 为约 `0.3x`，但服务端价格和可用模型可能动态变化，所以必须以运行时列表为准。

---

# 16. 性能优化

## 保持 Qoder CLI 常驻

不要：

```text
request
→ spawn qodercli
→ request
→ exit
```

而应该：

```text
Bridge startup
↓
startup()
↓
保持 qodercli process
↓
处理多次请求
```

Qoder SDK专门提供 `startup()`，用途就是预先完成 CLI initialization handshake，从首个 query中移除进程启动延迟。

## 不加载工作目录规则

```text
settingSources: []
```

否则用户级和项目级 instruction可能偷偷进入上下文，影响 benchmark reproducibility。

## 禁用 Skills

```text
skills: []
```

## 禁用 Qoder built-in tools

```text
tools: []
```

只有 Phase 1 tool interception时才暴露我们自己注册的工具。

---

# 17. Telemetry

每次 request建议保存一条 NDJSON：

```json
{
  "request_id": "...",
  "model": "...",
  "reasoning_effort": "max",

  "input_tokens": 0,
  "output_tokens": 0,

  "ttft_ms": 0,
  "api_ms": 0,
  "wall_ms": 0,

  "model_requests": 1,
  "tool_calls": 0,

  "credits": 0,
  "total_session_credits": 0,

  "result": "success"
}
```

这是后续判断项目有没有意义的核心数据。

---

# 18. 最终性能指标

后续至少比较四种环境：

```text
A. Qoder 原生 Agent
B. QoderBridge + Minimal Harness
C. QoderBridge + DeepSeek Harness
D. DeepSeek Harness + 原生 API
```

D只需要少量测试作为性能参考，不需要作为长期实际使用方案。

主要指标：

```text
Task success rate

Wall-clock time
TTFT

LLM request count
Tool call count

Input tokens
Output tokens

Credits
Credits / solved task

Time / solved task
```

特别关注：

```text
QoderBridge / Qoder Agent
```

如果最终达到例如：

```text
相同质量
+
wall time降低 30%以上
+
credits降低 20%以上
```

就已经具有实际使用价值。

---

# 19. 与 DeepSeek Harness 对接

DSH提供 Custom Provider机制，可以填写：

```text
Provider ID
Base URL
API protocol
credential
models
```

并支持 OpenAI Chat Completions。

预计配置类似：

```yaml
provider: qoderbridge
baseURL: http://127.0.0.1:8642/v1
api: openai-completions
model: deepseek-v4.1-flash-qoder
```

但具体 compat参数必须在 Bridge API定型以后确定。

例如 DSH可能发送：

```text
developer role
max_completion_tokens
```

官方文档明确提醒一些 OpenAI-compatible gateway对此并不兼容，因此 Bridge应主动兼容这些字段，而不是要求 DSH做特殊适配。

---

# 20. OpenCode 支持

OpenCode允许定义：

```json
{
  "provider": {
    "qoderbridge": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8642/v1"
      }
    }
  }
}
```

因此只要 Chat Completions兼容完成，OpenCode原则上不需要额外实现专用 adapter。

OpenCode应放在 DSH验证完成以后测试。

---

# 21. 不应采用的方案

明确禁止项目走向：

```text
抓取 Qoder内部 HTTP API
```

或者：

```text
提取内部 session token
```

或者：

```text
逆向 Qoder私有模型 endpoint
```

原因有两个。

技术上：

```text
endpoint可能随时变化
auth协议可能变化
客户端签名可能变化
模型 routing可能变化
```

而且完全没有必要，因为官方已经提供 SDK。

更重要的是，Qoder现行条款明确限制 reverse engineering、自动化 scraping/distillation、规避收费以及使用服务开发与其功能相似或竞争的服务。

因此项目必须坚持：

> 只通过官方公开 Agent SDK / CLI接口访问服务，并正常消耗 Qoder Credits。

即便如此，把 Qoder SDK包装为其他 coding harness的模型 backend 是否属于其条款允许范围，官方没有给出明确授权。

所以这是一个**条款风险点，而不是技术风险点**。

建议项目定位：

```text
private local experimental integration
```

而不是：

```text
公开模型 API 服务
商业 Provider
多人共享 gateway
```

---

# 22. 推荐技术栈

首选：

```text
TypeScript
Node.js

@qoder-ai/qoder-agent-sdk
```

原因：

1. Qoder官方 SDK能力完整；
2. `query()`、streaming、interrupt、AbortController支持成熟；
3. 后续实现 OpenAI-compatible HTTP server方便；
4. JSON Schema/tool mapping更自然；
5. 与 DSH/OpenCode技术栈接近；
6. debugging message stream方便。

HTTP server可选：

```text
Fastify
Hono
Express
```

框架不是项目核心，不应过度设计。

---

# 23. 推荐目录结构

```text
qoderbridge/
├── src/
│   ├── qoder/
│   │   ├── client.ts
│   │   ├── model.ts
│   │   ├── session.ts
│   │   ├── usage.ts
│   │   └── tool-interceptor.ts
│   │
│   ├── bridge/
│   │   ├── conversation.ts
│   │   ├── message-mapper.ts
│   │   ├── tool-mapper.ts
│   │   └── session-manager.ts
│   │
│   ├── api/
│   │   ├── models.ts
│   │   ├── chat-completions.ts
│   │   └── streaming.ts
│   │
│   ├── telemetry/
│   │   └── logger.ts
│   │
│   └── main.ts
│
├── tests/
│   ├── thin-inference.test.ts
│   ├── tool-intercept.test.ts
│   ├── session.test.ts
│   └── openai-compat.test.ts
│
├── scripts/
│   ├── benchmark-thin.ts
│   └── benchmark-qoder-agent.ts
│
├── package.json
└── README.md
```

---

# 24. Codex第一轮实现范围

Codex第一轮**不要实现完整项目**。

只实现：

```text
Phase 0
+
Phase 1 Gate
```

即：

### Phase 0

实现：

```text
Qoder SDK认证
runtime model discovery
DeepSeek Flash选择
tools=[]
skills=[]
settingSources=[]
custom systemPrompt
maxTurns=1
streaming
credits telemetry
latency telemetry
```

提供 CLI：

```bash
qoderbridge probe "Solve this problem..."
```

输出：

```text
response
model
TTFT
wall time
model request count
credits
```

### Phase 1

创建一个假的：

```text
read_file(path)
```

native custom tool。

让模型调用它。

程序必须：

```text
捕获 tool name
捕获 arguments
阻止工具真正执行
立即停止 Qoder Agent
确认没有第二次 LLM request
```

输出：

```json
{
  "captured": true,
  "tool": "read_file",
  "arguments": {
    "path": "..."
  },
  "model_requests": 1,
  "extra_model_request": false
}
```

---

# 25. 第一阶段成功条件

全部满足才认为完整方案可行：

```text
[ ] DeepSeek Flash 可以稳定固定选择

[ ] tools=[] 后只发生一次模型请求

[ ] Qoder默认 Agent行为明显减少

[ ] systemPrompt可以完全替换

[ ] skills/settings完全关闭

[ ] request-level Credits可读取

[ ] tool call可以在执行前截获

[ ] tool arguments完整

[ ] interrupt后不存在额外LLM retry

[ ] session状态仍可控制
```

如果前六项通过、后三项失败：

```text
项目仍然可做
```

但最终架构只能使用：

```text
Minimal Action Protocol
```

而不能作为透明的 native OpenAI tool-calling Provider。

---

# 26. 最终判断

经过官方文档重新核查后，可以确认：

### 核心设想是成立的

Qoder官方 SDK已经给予足够控制能力，可以：

```text
去除工具
去除 Skills
去除项目规则
覆盖 system prompt
固定模型
固定推理参数
限制 turns
保持 CLI常驻
读取 token / Credits / latency
```

因此将 Qoder削成一个明显比默认 Agent更薄的模型访问层，在技术上是合理且可实施的。

### 最大未知点只有一个

即：

> **能否把 native tool call截获后立即结束当前 Qoder turn，而不让 Qoder自行消费 tool result并重新调用模型。**

Qoder SDK已经提供：

```text
custom tools
canUseTool
interrupt
streaming tool arguments
```

因此实现可能性较高，但必须通过 PoC，而不能在架构设计阶段当成既定事实。

### 因此推荐决策

**GO — 进入 PoC。**

但开发顺序必须严格为：

```text
Thin Inference
      ↓
Tool Interception Gate
      ↓
OpenAI-Compatible Bridge
      ↓
DeepSeek Harness
      ↓
OpenCode
      ↓
Benchmark
```

不要倒过来。

如果第二步失败，也不要继续硬做协议兼容层，而是退回 Minimal Action Protocol。

这样整个项目不会建立在未经验证的 Qoder Agent行为假设上。