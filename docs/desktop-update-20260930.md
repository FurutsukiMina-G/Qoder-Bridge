# 2026-09-30 官方桌面升级与 Bridge 验收

已在原安装路径将官方桌面端从 `0.1.7-rc.2` 更新为 `0.2.0-rc.2`。新桌面已启动，QoderBridge 的 `8646` 服务持续运行，Flash / Pro 均可选择，保留原默认 Flash。

## 安装与数据

安装包来自官方 production 更新源，289,313,640 字节，SHA-512 与 `nightly.yml` 一致，Windows Authenticode 签名有效，发布者为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd.。使用官方安装器原路径升级，安装退出码为 0；当前应用包版本为 `0.2.0-rc.2`，构建提交为 `04f392c9ddd144fa426da2045178797da6db6c11`。

工作数据保留在 `%USERPROFILE%\.dsh`。升级前用 `scripts/backup-dsh-data.ts` 备份了该目录以及官方/旧桌面的用户设置目录，逐文件 SHA-256 验证成功；运行库链接只记录目标，没有递归进入程序依赖。备份位于 `.runtime/update-backup-20260930`，包含私人凭据，继续保持本机存储和 Git 忽略。

更新后原有可见会话全部可读取，原会话文件的完整原始内容逐字节保留，凭据哈希一致。其中一个历史测试会话被新版正常追加了 `session/end-seed` 事件，其旧压缩文件仍是新文件的完整前缀；无历史内容被改写。

完成验收后删除旧 `DeepSeek Harness-legacy-0.3.20` 程序目录、旧 `.runtime/dsh-old-shell` / `dsh-new-shell` 程序测试副本，以及 `0.1.7-rc.2` 安装器，共释放 1,590,180,909 字节（约 1.59 GB）。新程序、新版兼容测试副本 `.runtime/dsh-current-shell`、工作数据、旧数据备份和新数据备份均保留。清理前核查了绝对目标路径、运行进程、数据链接及目录中的重解析点，采用直接删除程序目录，未调用旧版卸载器。

## 新版适配

新版使用 pi-ai `0.87.1`，OpenAI Chat Completions 协议仍兼容现有 Bridge。新版内部以 system message 的 `toolsAdded` 携带工具声明，因此离线适配检查脚本改为经过其 `normalizeContext()` 后调用底层 stream；Bridge 接收的 HTTP 工具 Schema 正常，无需修改运行中的模型路由。

新版实际适配器的四项离线检查均通过：带缓存字段的用量、缺缓存字段的用量、原生工具参数、无效回答的 SSE error 终态。输入和缓存只计算一次，推理 token 映射为独立字段但已包含在输出总数中，不重复计入总 token。fixture 日志写入独立测试目录，不混入真实消耗日志。

## 实际 Harness 测试

| 模型 | 原生工具 | 模型请求 | 上游模型错误 | Credits | 输入 / 输出 token | 解码速率 |
|---|---|---:|---:|---:|---:|---:|
| Qoder DeepSeek V4 Pro | read | 2 | 0 | 0.959584032 | 16,711 / 225 | 56.72 tok/s |
| Qoder DeepSeek Flash | pwsh | 2 | 0 | 0.0511744376 | 16,557 / 135 | 56.77 tok/s |

两者均执行了 Harness 自己的工具、接回实际随机文件标记、完成最终回复；分别路由到 `DeepSeek-V4-Pro` 和 `DeepSeek-Flash`。各自工具续接使用同一个 Qoder 会话，不同 Harness 测试会话的 Qoder 历史独立。模型策略和 Harness 上下文窗口均为 1,000,000 / max。正文与思考已实际流入 Harness，正文续接首块约 Pro 2.187 秒、Flash 1.518 秒。这是短测试数据，尚未验证占满 1M 的长任务吞吐。

两次初始 PowerShell 测试因临时目录缺少 Windows 沙箱初始化所需的用户权限而停止，未执行其后提出的权限修复命令。随后只在一个独立临时测试目录给当前用户补齐完整权限（原权限保存在 `.runtime/pwsh-fixture-original-permissions.sddl`），保留项目与上级目录权限，在原生 workspace-write 沙箱下重测成功。初始测试消耗 0.596660328 Credits，全部计入本次测试总消耗 **1.6074187976 Credits**；所有模型请求均成功，目录权限错误属于工具环境错误。

token 仍是 Bridge 从 Qoder 上下文比例与流式 delta 推导的用量；本次确认其在新版 Harness 的显示、解码计时及上下文压力计算正常，不能视为上游官方精确计数。Qoder 真实缓存命中仍未知，默认未发送缓存字段；离线缓存检查只证明字段兼容，未制造真实缓存统计。

原有 51 项自动检查、TypeScript 检查与构建通过。Bridge 的在线服务无需重启。

## 本机记录与复核

- `reports/desktop-update-20260930.json`：数据完整性、实际模型、工具、流式延迟、token、Credits 与健康状态。
- `reports/desktop-old-program-cleanup-20260930.json`：已删除程序路径与字节数。
- `reports/adapter-smoke.json`：新版 pi-ai 离线适配检查。
- `.runtime/update-backup-20260930/manifest.json`：私人数据的逐文件哈希与链接目标。

以下命令在仓库根目录运行，只读取已完成的测试与本机日志，不发新模型请求（末尾可附上被丢弃的初始测试会话 ID）：

```powershell
npm.cmd run status
node --import tsx scripts/adapter-smoke.ts
node --import tsx scripts/verify-desktop-update.ts .runtime/update-backup-20260930 .runtime/desktop-update-cases-20260930.json .runtime/dsh-current-shell [初始测试会话 ID ...]
```

官方参考：[0.2.0-rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[桌面安装及数据保留说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)、[Windows production 更新源](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml)。
