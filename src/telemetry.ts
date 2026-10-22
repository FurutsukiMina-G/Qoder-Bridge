import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SDKMessage, SDKAssistantMessage, SDKResultMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { aggregateUsage, measuredUsage, reportedUsage, tokenDeltasReliable, type StreamTokens } from './usage.js';
import { sdkErrorCode, sdkExceptionDetails, type SDKExceptionDetails } from './failures.js';
import {ModelResponseCounter} from './response-counts.js';
const API_ERROR_CODES = new Set(['authentication_failed', 'billing_error', 'rate_limit', 'invalid_request',
  'server_error', 'unknown', 'max_output_tokens']);
const apiErrorCode = (value: unknown) => typeof value === 'string' && API_ERROR_CODES.has(value) ? value : 'unknown';

export class Telemetry {
  readonly request_id = randomUUID();
  readonly started = performance.now();
  ttft_ms: number | null = null;
  first_event_ms: number | null = null;
  policyCalls: Array<{ purpose: string; turn_index: number; model: string }> = [];
  assistants = new Map<string, SDKAssistantMessage>();
  result?: SDKResultMessage;
  exception: SDKExceptionDetails | null = null;
  captureException(error: unknown) { this.exception = sdkExceptionDetails(error); }
  text = '';
  streamed = false;
  textDeltaCount = 0;
  thinkingDeltaCount = 0;
  thinkingChars = 0;
  lastDeltaMs: number | null = null;
  private streamUsage = new Map<string, Record<string, unknown>>();
  private streamTokens = new Map<string, StreamTokens>();
  private responseCounter=new ModelResponseCounter();
  private streamKey = 'stream-0';
  private unstreamedText = false;
  private streamStopReasons = new Set<string>();
  finished: number | null = null;
  apiRetries = 0;
  private apiRetryDetails: Array<{ attempt: number; max_retries: number; retry_delay_ms: number;
    error_status: number | null; error: string }> = [];
  private apiErrorCategories: string[] = [];
  private modelQueueStatuses: Array<{ status: 'queued' | 'ready'; queue_count: number | null;
    wait_time_ms: number | null; queue_wait_elapsed_ms: number | null; queue_max_wait_ms: number | null;
    service_available: boolean | null }> = [];
  session_id: string | null = null;
  cli_version: string | null = null;
  init: { tools: string[]; skills: string[]; plugins: unknown[] } | null = null;
  private tokens(key = this.streamKey) {
    let row = this.streamTokens.get(key);
    if (!row) this.streamTokens.set(key, row = { contextRatio: null, textTokens: 0, reasoningTokens: 0,
      chars: 0, maxDeltaChars: 0, foreignDeltas: 0 });
    return row;
  }
  private delta(kind: 'textTokens' | 'reasoningTokens', text: string) {
    const row = this.tokens();
    row[kind]++; row.chars += text.length; row.maxDeltaChars = Math.max(row.maxDeltaChars, text.length);
  }
  observe(message: SDKMessage, output: (text: string) => void = () => {}, thinking: (text: string) => void = () => {},
    status: (text: string) => void = () => {}) {
    this.session_id = message.session_id ?? this.session_id;
    if (message.type === 'system' && message.subtype === 'init') {
      this.cli_version = message.qodercli_version;
      this.init = { tools: message.tools, skills: message.skills, plugins: message.plugins };
    }
    if (message.type === 'system' && message.subtype === 'api_retry') {
      this.responseCounter.retry();
      this.apiRetries++;
      this.apiRetryDetails.push({ attempt: message.attempt, max_retries: message.max_retries,
        retry_delay_ms: message.retry_delay_ms, error_status: message.error_status, error: apiErrorCode(message.error) });
      if (this.apiRetryDetails.length > 16) this.apiRetryDetails.shift();
      // Upstream backoff produces no model deltas; surface it so a client idle watchdog sees progress.
      status(`[QoderBridge] Qoder upstream retry ${message.attempt}/${message.max_retries}` +
        `${typeof message.error_status === 'number' ? ` (HTTP ${message.error_status})` : ''}; ` +
        `next attempt in ${Math.max(0, Math.round(message.retry_delay_ms / 1000))}s.`);
    }
    if (message.type === 'system' && message.subtype === 'model_queue_status') {
      this.modelQueueStatuses.push({ status: message.status, queue_count: message.queue_count ?? null,
        wait_time_ms: message.wait_time_ms ?? null, queue_wait_elapsed_ms: message.queue_wait_elapsed_ms ?? null,
        queue_max_wait_ms: message.queue_max_wait_ms ?? null, service_available: message.service_available ?? null });
      if (this.modelQueueStatuses.length > 16) this.modelQueueStatuses.shift();
    }
    if (message.type === 'assistant' && message.isApiErrorMessage) {
      this.apiErrorCategories.push(apiErrorCode(message.error));
      if (this.apiErrorCategories.length > 16) this.apiErrorCategories.shift();
    }
    if (message.type === 'stream_event') {
      const event = message.event as unknown as { type: string; message?: { id?: string; usage?: Record<string, unknown> };
        usage?: Record<string, unknown>; delta?: { type?: string; text?: string; thinking?: string; stop_reason?: unknown } };
      if (event.type === 'message_start') {
        this.responseCounter.streamStart(event.message?.id);
        this.streamKey = event.message?.id ?? `stream-${this.streamTokens.size}`;
        this.tokens();
        if (event.message?.usage) this.streamUsage.set(this.streamKey, { ...event.message.usage });
      }
      if(event.type==='content_block_delta'||event.type==='message_delta')this.responseCounter.streamActivity();
      if (event.type === 'message_delta' && event.usage)
        this.streamUsage.set(this.streamKey, { ...this.streamUsage.get(this.streamKey), ...event.usage });
      const ratio = this.streamUsage.get(this.streamKey)?.context_usage_ratio;
      if (typeof ratio === 'number') this.tokens().contextRatio = ratio;
      const delta = event.delta;
      if (event.type === 'message_delta' && typeof delta?.stop_reason === 'string') this.streamStopReasons.add(delta.stop_reason);
      if (message.event.type === 'content_block_delta') this.first_event_ms ??= performance.now() - this.started;
      if (delta?.type === 'text_delta' && delta.text) {
        this.ttft_ms ??= performance.now() - this.started;
        this.textDeltaCount++; this.lastDeltaMs = performance.now() - this.started;
        this.delta('textTokens', delta.text);
        this.streamed = true; this.text += delta.text; output(delta.text);
      }
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingDeltaCount++; this.thinkingChars += delta.thinking.length;
        this.lastDeltaMs = performance.now() - this.started;
        this.delta('reasoningTokens', delta.thinking);
        thinking(delta.thinking);
      }
      // Partial tool JSON and other delta kinds are not per-token; they make delta counting unusable.
      if (message.event.type === 'content_block_delta' && delta?.type &&
        !['text_delta', 'thinking_delta', 'signature_delta'].includes(delta.type)) this.tokens().foreignDeltas++;
    }
    if (message.type === 'assistant' && !message.isApiErrorMessage) {
      this.responseCounter.assistant(message.request_id,message.message.id);
      const key = message.request_id ?? message.message.id ?? message.uuid;
      const seen = this.assistants.has(key);
      this.assistants.set(key, message);
      if (!this.streamed && !seen) {
        const text = message.message.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
        if (text) {
          this.unstreamedText = true;
          this.ttft_ms ??= performance.now() - this.started; this.text += text; output(text);
        }
      }
    }
    if (message.type === 'result') { this.result = message; this.finished = performance.now(); }
  }
  /** @param contextWindow - window our model policy selected; the denominator of `context_usage_ratio`. */
  snapshot(contextWindow: number | null = null) {
    const resultUsage = reportedUsage(this.result?.usage);
    const streamUsage = aggregateUsage([...this.streamUsage.values()]);
    const assistantUsage = aggregateUsage([...this.assistants.values()].map(row => row.message.usage));
    const streams = [...this.streamTokens.values()];
    const resultRatio = (this.result?.usage as { context_usage_ratio?: unknown } | undefined)?.context_usage_ratio;
    if (streams.length === 1 && streams[0]!.contextRatio === null && typeof resultRatio === 'number')
      streams[0] = { ...streams[0]!, contextRatio: resultRatio };
    const measured = this.unstreamedText || !this.result ? null : measuredUsage(streams, contextWindow);
    const usage = resultUsage ?? streamUsage ?? assistantUsage ?? measured;
    const decodeMs = this.first_event_ms !== null && this.lastDeltaMs !== null ? this.lastDeltaMs - this.first_event_ms : null;
    const rows = [...this.assistants.values()].map(m => ({
      request_id: m.request_id ?? null, message_id: m.message.id ?? m.uuid,
      model: m.message.model ?? null, input_tokens: m.message.usage?.input_tokens ?? null,
      output_tokens: m.message.usage?.output_tokens ?? null,
      credits: m.message.usage?.credits ?? null, original_credits: m.message.usage?.original_credits ?? null,
      billable: m.message.usage?.billable ?? null,
      stop_reason: (m.message as unknown as { stop_reason?: unknown }).stop_reason ?? null,
      content_types: m.message.content.map(part => part.type),
    }));
    const sum = (field: 'credits' | 'original_credits' | 'input_tokens' | 'output_tokens') =>
      rows.length && rows.every(r => typeof r[field] === 'number') ? rows.reduce((n, r) => n + r[field]!, 0) : null;
    const streamCreditRows = [...this.streamUsage.values()];
    const streamCredits = streamCreditRows.length && streamCreditRows.every(row =>
      typeof row.credits === 'number' && Number.isFinite(row.credits) && row.credits >= 0)
      ? streamCreditRows.reduce((total, row) => total + (row.credits as number), 0) : null;
    const assistantCredits = sum('credits');
    // Per-response list-price Credits; promotions only change `credits`, so billing inversion prefers these.
    const streamOriginalCredits = streamCreditRows.length && streamCreditRows.every(row =>
      typeof row.original_credits === 'number' && Number.isFinite(row.original_credits) && row.original_credits >= 0)
      ? streamCreditRows.reduce((total, row) => total + (row.original_credits as number), 0) : null;
    return {
      request_id: this.request_id, session_id: this.session_id, cli_version: this.cli_version,
      model: this.policyCalls[0]?.model ?? null,
      ttft_ms: this.ttft_ms, first_event_ms: this.first_event_ms,
      wall_ms: (this.finished ?? performance.now()) - this.started, api_ms: this.result?.duration_api_ms ?? null,
      sdk_wall_ms: this.result?.duration_ms ?? null,
      result_token_usage: this.result?.usage ?? null,
      result_model_usage: this.result?.modelUsage ?? null,
      sdk_errors: this.result && 'errors' in this.result ? this.result.errors.map(safeError) : [],
      sdk_error_code: sdkErrorCode(this.result?.error_code) ?? this.exception?.result_error_code ?? null,
      sdk_exception: this.exception,
      ...this.responseCounter.snapshot(),
      policy_calls: this.policyCalls, assistant_messages: rows.length, api_retries: this.apiRetries,
      api_retry_details: [...this.apiRetryDetails], api_error_categories: [...this.apiErrorCategories],
      model_queue_statuses: [...this.modelQueueStatuses],
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), credits: assistantCredits ?? streamCredits,
      request_credits_source: assistantCredits !== null ? 'assistant' : streamCredits !== null ? 'stream_events' : 'unavailable',
      token_usage_status: resultUsage || streamUsage || assistantUsage ? 'reported'
        : measured ? 'measured_context_ratio_and_stream_deltas'
        : rows.length && sum('input_tokens') === 0 && sum('output_tokens') === 0 ? 'zero_filled_unreliable' : 'not_reported',
      normalized_usage: usage,
      normalized_usage_source: resultUsage ? 'result' : streamUsage ? 'stream_events' : assistantUsage ? 'assistant'
        : measured ? 'qoder_context_ratio+stream_token_deltas' : 'unavailable',
      context_window: contextWindow,
      context_usage_ratio: streams.at(-1)?.contextRatio ?? (typeof resultRatio === 'number' ? resultRatio : null),
      stream_token_counts: streams.map(row => ({ ...row, reliable: tokenDeltasReliable(row) })),
      streamed_token_deltas_reliable: !this.unstreamedText && streams.length>0 && streams.every(tokenDeltasReliable),
      streamed_output_tokens: this.textDeltaCount+this.thinkingDeltaCount,
      streamed_reasoning_tokens: this.thinkingDeltaCount,
      reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      // Bridge-observed decode rate: output tokens over first-delta to last-delta time, like Harness tok/s.
      output_tokens_per_second: usage && decodeMs && decodeMs > 0 && usage.completion_tokens > 1
        ? usage.completion_tokens / (decodeMs / 1000) : null,
      cache_usage_status: usage?.prompt_tokens_details ? 'reported' : 'not_reported_by_qoder',
      cache_hit_ratio: usage?.prompt_tokens_details && usage.prompt_tokens > 0
        ? usage.prompt_tokens_details.cached_tokens / usage.prompt_tokens : null,
      stream_usage_snapshots: [...this.streamUsage.values()],
      text_delta_count: this.textDeltaCount, thinking_delta_count: this.thinkingDeltaCount,
      thinking_chars: this.thinkingChars, last_delta_ms: this.lastDeltaMs,
      original_credits: sum('original_credits'), total_session_credits: this.result?.total_credits ?? null,
      stream_original_credits: streamOriginalCredits,
      stream_billable: streamCreditRows.some(row => row.billable === false) ? false
        : streamCreditRows.some(row => row.billable === true) ? true : null,
      billable: rows.map(r => r.billable), requests: rows,
      result: this.result?.subtype ?? 'incomplete', terminal_reason: this.result?.terminal_reason ?? null,
      stream_stop_reasons: [...this.streamStopReasons],
      init: this.init,
    };
  }
}

export function safeError(error: unknown) {
  let text = error instanceof Error ? error.message : String(error);
  for (const key of ['QODERCN_PERSONAL_ACCESS_TOKEN', 'QODER_PERSONAL_ACCESS_TOKEN']) {
    const secret = process.env[key]; if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}
export async function appendReport(file: string, report: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(report) + '\n', 'utf8');
}
