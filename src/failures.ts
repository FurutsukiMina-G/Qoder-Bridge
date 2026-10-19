import type { RecoveryTrace } from './decision-recovery.js';

export type FailurePhase = 'request' | 'queue' | 'upstream' | 'decision' | 'reporting' | 'delivery';
export type FailureOrigin = 'account' | 'bridge' | 'model_output' | 'upstream' | 'dsh_request' | 'connection' | 'unknown';
/** Codes are metadata, not an opportunity to copy provider text/commands into the UI. */
export function sdkErrorCode(value: unknown): number | string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value
    : typeof value === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(value) ? value : null;
}
export function sdkExceptionDetails(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const result = value.result && typeof value.result === 'object' ? value.result as Record<string, unknown> : {};
  return { name: sdkErrorCode(value.name), code: sdkErrorCode(value.code),
    exit_code: sdkErrorCode(value.exitCode), result_error_code: sdkErrorCode(result.error_code) };
}
export type SDKExceptionDetails = ReturnType<typeof sdkExceptionDetails>;
type Diagnosis = { origin: FailureOrigin; code: string; reason: string; action: string; evidence: string };
const accountAction = '检查 Qoder 账号的套餐、对应额度或登录状态；条件恢复后再继续，不要反复重试。';
const diagnosis = (origin: FailureOrigin, code: string, reason: string, action: string, evidence: string): Diagnosis =>
  ({ origin, code, reason, action, evidence });

/** Official result.error_code namespace. A process exit code is deliberately NOT interpreted here. */
export function upstreamDiagnosis(errors: unknown[] = [], categories: string[] = [], code: unknown = null): Diagnosis | null {
  const key = sdkErrorCode(code);
  const accountReasons: Record<string, [string, string]> = {
    '105': ['upstream_authentication_failed', 'Qoder 登录凭据已过期。'],
    '110': ['upstream_daily_limit', 'Qoder 账号达到每日用量上限（daily usage limit）；不等同于积分余额耗尽。'],
    '113': ['upstream_quota_exhausted', 'Qoder 账号使用额度已耗尽。'],
    '114': ['upstream_free_trial_limit', 'Qoder 免费试用账号受到用量限制。'],
    '115': ['upstream_free_user_limit', 'Qoder 免费用户额度受到限制。'],
    '116': ['upstream_team_admin_credits', 'Qoder 团队管理员积分不足。'],
    '117': ['upstream_team_member_credits', 'Qoder 团队成员积分不足。'],
    '118': ['upstream_personal_credits', 'Qoder 个人积分不足。'],
    '119': ['upstream_model_free_quota', '所选模型的免费使用额度已耗尽。'],
    '122': ['upstream_billing_group_credits', 'Qoder 计费组积分不足。'],
  };
  const account = key === null ? undefined : accountReasons[String(key)];
  if (account) return diagnosis('account', account[0], account[1], accountAction, 'sdk_result_error_code');
  const reasons: Record<string, [FailureOrigin, string, string, string]> = {
    '406': ['upstream', 'upstream_policy_blocked', '上游策略拒绝了本次请求。', '检查请求是否符合服务策略；不要自动绕过限制。'],
    '416': ['dsh_request', 'upstream_request_unsatisfiable', '上游无法满足本次请求的范围或形式。', '检查 DSH 的模型设置和请求参数。'],
    '430': ['dsh_request', 'upstream_capability_unsupported', '上游不支持本次请求的能力。', '核对 DSH 模型能力配置与 Bridge 支持范围。'],
    '47902': ['upstream', 'qoder_turn_limit', 'Qoder SDK 达到单次请求轮数上限，未完成模型决策。', '保留请求 ID 排查 SDK 终止原因；不要直接放大轮数。'],
    '48716': ['upstream', 'upstream_hook_blocked', 'Qoder SDK 的 Hook 阻止了请求。', '检查 SDK Hook 和权限规则，不要自动批准或绕过。'],
    '80411': ['dsh_request', 'upstream_input_too_long', '上游拒绝请求：输入上下文过长。', '检查 DSH 上下文压缩及所选模型窗口。'],
    '80412': ['dsh_request', 'upstream_too_many_attachments', '上游拒绝请求：附件数量过多。', '减少请求附件并检查客户端配置。'],
    '500': ['upstream', 'upstream_request_failed', 'Qoder SDK 报告请求或网络失败，尚不能区分网络、SDK 与模型服务。', '凭请求 ID 检查 Bridge 日志和上游状态。'],
    '10408': ['upstream', 'upstream_timeout', '上游报告请求超时。', '检查上游可用性和连接，避免重复提交同一操作。'],
    '10500': ['upstream', 'upstream_service_error', '上游明确报告模型服务内部错误。', '保留请求 ID，待服务恢复后再继续。'],
    '10605': ['upstream', 'upstream_queue', '上游报告模型服务排队。', '检查上游排队状态，避免并行重复请求。'],
  };
  const known = key === null ? undefined : reasons[String(key)];
  if (known) return diagnosis(...known, 'sdk_result_error_code');
  // Human-readable fallback only; do not manufacture a numeric error_code from this text.
  const text = errors.filter((v): v is string => typeof v === 'string').join('\n');
  if (/\b(?:reached|exceeded)\b[\s\S]{0,100}\bdaily\s+(?:usage\s+)?limit\b|\bdaily\s+(?:usage\s+)?limit\b[\s\S]{0,100}\b(?:reached|exceeded|exhausted)\b/i.test(text))
    return diagnosis('account', 'upstream_daily_limit', 'Qoder 账号达到每日用量上限（daily usage limit）；不等同于积分余额耗尽。', accountAction, 'sdk_error_text');
  if (categories.includes('billing_error')) return diagnosis('account', 'upstream_billing_error', '上游报告计费或额度错误，具体额度类型未确定。', accountAction, 'sdk_api_category');
  if (categories.includes('authentication_failed')) return diagnosis('account', 'upstream_authentication_failed', 'Qoder 上游账号认证失败。', accountAction, 'sdk_api_category');
  if (categories.includes('rate_limit')) return diagnosis('upstream', 'upstream_rate_limit', '上游触发请求频率限制。', '等待上游允许请求后再继续；不要反复重试。', 'sdk_api_category');
  if (categories.includes('server_error')) return diagnosis('upstream', 'upstream_service_error', '上游报告服务端错误。', '保留请求 ID 检查服务状态。', 'sdk_api_category');
  if (key !== null) return diagnosis('upstream', 'upstream_unknown_error_code', '上游 SDK 返回尚未识别的错误码，具体故障来源未确定。', '保留 SDK 错误码与请求 ID 进一步排查。', 'sdk_result_error_code');
  return null;
}

const labels: Record<FailureOrigin, string> = { account: '账号', bridge: 'Bridge', model_output: '模型输出/协议',
  upstream: '上游服务/SDK', dsh_request: 'DSH/客户端请求', connection: '连接/客户端中断', unknown: '来源未确定' };
export type FailureInput = {
  requestId: string; phase: FailurePhase; accepted: boolean; cause?: unknown;
  abort?: 'deadline' | 'client_disconnect'; early?: 'authentication' | 'route';
  turn?: { sdk_error_code?: number | string | null; sdk_errors?: unknown[]; api_error_categories?: string[];
    sdk_exception?: SDKExceptionDetails | null; result?: string; stage?: string; error?: string | null;
    stream_stop_reasons?: string[] };
  recovery?: RecoveryTrace;
};
export function bridgeFailure(input: FailureInput) {
  const t = input.turn;
  const exception = t?.sdk_exception ?? sdkExceptionDetails(input.cause);
  const sdkCode = sdkErrorCode(t?.sdk_error_code) ?? exception.result_error_code;
  const outcome = input.recovery?.outcome;
  const upstream = upstreamDiagnosis(t?.sdk_errors, t?.api_error_categories, sdkCode);
  let d: Diagnosis | null = null;
  if (input.early === 'authentication') d = diagnosis('dsh_request', 'bridge_authentication_failed', 'DSH 请求使用的 Bridge 本地访问密钥不正确；这不是 Qoder 账号登录错误。', '核对 DSH 模型提供商配置中的 Bridge 密钥。', 'bridge_authentication');
  else if (input.early === 'route') d = diagnosis('dsh_request', 'bridge_endpoint_not_found', 'DSH 请求的 Bridge 接口或 HTTP 方法不存在。', '核对 DSH 的提供商类型及 base URL。', 'bridge_route');
  else if (input.abort === 'deadline') d = diagnosis('bridge', 'bridge_request_timeout', '请求达到 Bridge 总时限，已中止等待；不据此认定账号受限或 DSH 故障。', '凭请求 ID 检查排队与上游耗时；不要重复提交未确认的操作。', 'bridge_deadline');
  else if (input.abort === 'client_disconnect') d = diagnosis('connection', 'client_disconnected', 'DSH/客户端连接已断开，可能是手动取消、客户端退出或连接故障。', '核对 DSH 端的取消记录；Bridge 无法向已断开的连接送达报错。', 'response_closed');
  else if (!input.accepted) d = diagnosis('dsh_request', 'invalid_request_error', 'DSH 发给 Bridge 的请求未通过格式、模型或工具 schema 校验。', '检查 DSH 模型配置和请求契约；详细校验原因见对应请求日志。', 'request_validation');
  else if (input.phase === 'reporting' || input.phase === 'delivery') d = diagnosis('bridge', 'bridge_internal_error', 'Bridge 在记录或交付响应时发生本地错误。', '凭请求 ID 检查 Bridge 日志、磁盘与运行状态。', 'bridge_phase');
  else if (upstream?.origin === 'account') d = upstream;
  // A Bridge output guard explains the SDK interrupt/max_turns it deliberately caused.
  else if (outcome === 'reasoning_budget') d = diagnosis('bridge', 'qoder_reasoning_budget', 'Bridge 推理保护预算已耗尽，模型始终未输出可执行决策；本次没有派发被拒绝的工具。', '检查推理保护与模型输出记录，避免自动开启新一轮付费循环。', 'bridge_reasoning_guard');
  else if (upstream?.evidence === 'sdk_result_error_code' && String(sdkCode) !== '47902') d = upstream;
  else if (outcome === 'output_budget' || t?.stream_stop_reasons?.some(r => ['max_tokens', 'length', 'model_context_window_exceeded'].includes(r)) || t?.api_error_categories?.includes('max_output_tokens'))
    d = diagnosis('upstream', 'qoder_output_budget', '上游输出或上下文预算已耗尽，模型响应未完成。', '检查上下文与输出预算；不要补写截断内容或自动放大预算。', 'sdk_output_budget');
  if (!d) d = upstream;
  if (!d && ['auth_not_configured', 'auth_access_token_env_var_not_configured', 'auth_service_account_env_var_not_configured'].includes(String(exception.code)))
    d = diagnosis('account', 'upstream_authentication_failed', 'Qoder SDK 缺少所需认证配置。', accountAction, 'sdk_exception_code');
  if (!d && exception.exit_code === 41) d = diagnosis('account', 'upstream_authentication_failed', 'Qoder CLI 以认证错误退出。', accountAction, 'sdk_process_exit_code');
  if (!d && [42, 44, 52].includes(Number(exception.exit_code))) d = diagnosis('bridge', 'sdk_local_configuration', 'Qoder CLI 报告本地参数、沙箱或配置错误。', '检查 Bridge 启动配置与 SDK 日志；不要自动改权限或 ACL。', 'sdk_process_exit_code');
  if (!d && (exception.exit_code === 130 || t?.result === 'error_cancelled')) d = diagnosis('connection', 'upstream_cancelled', 'SDK 报告请求已取消；无法仅凭此判断由用户、DSH 还是 SDK 发起。', '对照 DSH 与 Bridge 的取消记录。', 'sdk_cancellation');
  if (!d && (t?.result === 'error_max_turns' || t?.error?.includes('Qoder result: error_max_turns') || exception.exit_code === 53))
    d = diagnosis('upstream', 'qoder_turn_limit', 'Qoder SDK 达到单次请求轮数上限（per-request turn limit），未完成模型决策。', '保留请求 ID 排查终止原因；不要直接放大轮数。', 'sdk_terminal_result');
  if (!d && ['exhausted', 'repeated_invalid_decision', 'disabled'].includes(outcome ?? '')) d = diagnosis('model_output', outcome === 'disabled' ? 'model_decision_error' : 'model_decision_recovery_exhausted', '模型输出的工具名、参数或决策格式不符合 DSH/Bridge 契约，有界纠正已停止；被拒绝的工具未派发。', '凭请求 ID 检查模型原始输出与工具 schema，不能据此直接认定 DSH 程序故障。', 'decision_validation');
  if (!d && ['already_streamed', 'stream_conflict'].includes(outcome ?? '')) d = diagnosis('bridge', 'bridge_stream_conflict', 'Bridge 流式一致性保护停止响应，已发送的正文与最终决策不能安全拼接。', '检查同一请求的流式输出与最终决策；不要补写或重放工具。', 'bridge_stream_validation');
  if (!d && outcome === 'empty_response') d = diagnosis('upstream', 'upstream_empty_response', '上游结束时没有可用模型正文；尚不能确定是 SDK 还是模型输出问题。', '凭请求 ID 检查 SDK 结束事件与输出记录。', 'empty_response');
  if (!d && input.phase === 'decision') d = diagnosis('model_output', 'model_decision_error', '模型输出未能解析为符合 DSH/Bridge 契约的决策。', '凭请求 ID 检查输出格式与工具 schema。', 'decision_validation');
  d ??= diagnosis('unknown', 'unclassified_failure', '请求在 Bridge 与上游 SDK 边界失败，现有证据不足以定位到账号、模型服务、Bridge 或 DSH。', '保留请求 ID 对照 Bridge 与 DSH 日志；不要按猜测重试。', 'insufficient_evidence');
  const label = labels[d.origin];
  const message = `[${label}] ${d.reason}\n建议：${d.action}\n错误码：${d.code}${sdkCode !== null ? ` | SDK错误码：${sdkCode}` : ''} | 请求ID：${input.requestId}`;
  return { message, type: !input.accepted ? 'invalid_request_error' : 'upstream_error', code: d.code,
    origin: d.origin, origin_label: label, reason: d.reason, action: d.action, evidence: d.evidence,
    phase: input.phase, request_id: input.requestId, sdk_error_code: sdkCode, sdk_exception: exception,
    upstream_stage: t?.stage ?? null, automatic_retry: false };
}
