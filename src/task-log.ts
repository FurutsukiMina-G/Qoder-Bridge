import { createHash } from 'node:crypto';
import type { ChatRequest, Decision } from './compat.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function sessionKeyHash(key: string | undefined): string | null {
  return key ? digest(key).slice(0, 12) : null;
}
function preview(value: unknown, limit: number) {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
    return '[non-text content]';
  }).join('\n') : value === null || value === undefined ? '' : '[non-text content]';
  return { chars: text.length, sha256: digest(text), excerpt: text.slice(0, limit), truncated: text.length > limit };
}
type Turn = { session_id?: string | null; model?: string | null; reused_session?: boolean;
  wall_ms?: number | null; api_ms?: number | null; ttft_ms?: number | null;
  startup_ms?: number | null; credits_delta?: number | null; total_session_credits?: number | null;
  prompt_chars?: number; sent_tool_definition_chars?: number; tool_definitions_reused?: boolean;
  history_mode?: string; sent_message_count?: number; model_policy_calls?: unknown[];
  first_client_text_ms?: number | null; first_client_thinking_ms?: number | null; stream_chunks?: number;
  local_response_replay?: boolean; normalized_usage?: unknown; normalized_usage_source?: string;
  cache_usage_status?: string; cache_hit_ratio?: number | null;
  credits_delta_source?: string; client_usage?: unknown; client_cache_usage?: string;
  reasoning_tokens?: number | null; output_tokens_per_second?: number | null;
  cache_estimate_tokens?: number | null; cache_estimate_ratio?: number | null; context_usage_ratio?: number | null;
  decision_repairs?: unknown[]; stream_stop_reasons?: string[];
  api_retries?: number; api_retry_details?: unknown[]; api_error_categories?: string[]; model_queue_statuses?: unknown[];
};
export function taskLogEntry(args: { request: ChatRequest; turn?: Turn; decision?: Decision;
  bridgeRequestId: string; startedAt: number; error?: string; bridgePort?: number; }) {
  const { request, turn, decision } = args;
  const sent = turn?.history_mode === 'delta' && typeof turn.sent_message_count === 'number'
    ? turn.sent_message_count > 0 ? request.messages.slice(-turn.sent_message_count) : [] : request.messages;
  const roleCounts = Object.fromEntries(['system', 'developer', 'user', 'assistant', 'tool'].map(role =>
    [role, request.messages.filter(message => message.role === role).length]));
  const modelOutput = decision?.kind === 'final'
    ? { kind: 'final', content: preview(decision.content, 2048) }
    : decision?.kind === 'tool_call'
      ? { kind: 'tool_call', name: decision.name, arguments: preview(JSON.stringify(decision.arguments), 2048) }
      : decision?.kind === 'tool_calls'
        ? { kind: 'tool_calls', calls: decision.calls.map(call => ({ name: call.name,
          arguments: preview(JSON.stringify(call.arguments), 2048) })) }
      : null;
  return {
    schema: 'qoderbridge-task-v1', time: new Date().toISOString(),
    bridge_request_id: args.bridgeRequestId, bridge_port: args.bridgePort ?? null,
    harness_session_key_hash: sessionKeyHash(request.prompt_cache_key),
    qoder_session_id: turn?.session_id ?? null, status: args.error ? 'error' : 'success',
    error: args.error ?? null, elapsed_ms: Date.now() - args.startedAt,
    model: request.model, qoder_model: turn?.model ?? null, reused_qoder_session: turn?.reused_session ?? null,
    input: {
      message_count: request.messages.length, role_counts: roleCounts, new_message_count: sent.length,
      user_messages: sent.filter(message => message.role === 'user').map(message => preview(message.content, 4096)),
      tool_results: sent.filter(message => message.role === 'tool').map(message => ({
        tool_call_id: message.tool_call_id ?? null, content: preview(message.content, 1024),
      })),
      system_and_developer: sent.filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => ({ role: message.role, ...preview(message.content, 0) })),
      tools: { count: request.tools?.length ?? 0, names: request.tools?.map(tool => tool.function.name) ?? [],
        full_definition_chars: JSON.stringify(request.tools ?? []).length,
        sent_definition_chars: turn?.sent_tool_definition_chars ?? null },
      prompt_chars_to_qoder: turn?.prompt_chars ?? null,
    },
    output: modelOutput,
    telemetry: { wall_ms: turn?.wall_ms ?? null, api_ms: turn?.api_ms ?? null,
      ttft_ms: turn?.ttft_ms ?? null, startup_ms: turn?.startup_ms ?? null,
      credits_delta: turn?.credits_delta ?? null,
      credits_delta_source: turn?.credits_delta_source ?? (turn?.local_response_replay ? 'local_replay' : 'unavailable'),
      total_session_credits: turn?.total_session_credits ?? null,
      model_policy_calls: turn?.model_policy_calls ?? [],
      first_client_text_ms: turn?.first_client_text_ms ?? null,
      first_client_thinking_ms: turn?.first_client_thinking_ms ?? null, stream_chunks: turn?.stream_chunks ?? 0,
      local_response_replay: turn?.local_response_replay ?? false,
      usage: turn?.normalized_usage ?? null, usage_source: turn?.normalized_usage_source ?? 'unavailable',
      // Exactly what the Harness received; may carry the opt-in cache estimate that `usage` never does.
      client_usage: turn?.client_usage ?? null, client_cache_usage: turn?.client_cache_usage ?? 'omitted',
      reasoning_tokens: turn?.reasoning_tokens ?? null, output_tokens_per_second: turn?.output_tokens_per_second ?? null,
      context_usage_ratio: turn?.context_usage_ratio ?? null,
      decision_repairs: turn?.decision_repairs ?? [], stream_stop_reasons: turn?.stream_stop_reasons ?? [],
      api_retries: turn?.api_retries ?? null, api_retry_details: turn?.api_retry_details ?? [],
      api_error_categories: turn?.api_error_categories ?? [], model_queue_statuses: turn?.model_queue_statuses ?? [],
      cache_status: turn?.cache_usage_status ?? 'unavailable', cache_hit_ratio: turn?.cache_hit_ratio ?? null,
      cache_estimate_tokens: turn?.cache_estimate_tokens ?? null, cache_estimate_ratio: turn?.cache_estimate_ratio ?? null,
      tool_definitions_reused: turn?.tool_definitions_reused ?? null },
    context_transport: { history_mode: turn?.history_mode ?? null, sent_message_count: turn?.sent_message_count ?? null },
  };
}
