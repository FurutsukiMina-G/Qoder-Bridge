import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { reportedUsage, aggregateUsage, measuredUsage, prefixCacheEstimate, withCachedTokens,
  type StreamTokens } from '../src/usage.js';
import { Telemetry } from '../src/telemetry.js';

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const event = (value: unknown) => ({ type: 'stream_event', event: value }) as unknown as SDKMessage;
const stream = (over: Partial<StreamTokens> = {}): StreamTokens => ({ contextRatio: 0.000513, textTokens: 299,
  reasoningTokens: 455, chars: 1500, maxDeltaChars: 16, foreignDeltas: 0, ...over });
test('zero-filled or malformed usage never becomes a fabricated token or cache total', () => {
  assert.equal(reportedUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }), null);
  assert.equal(reportedUsage({ input_tokens: -5, output_tokens: 10 }), null);
  assert.equal(reportedUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: -1 }), null);
  const partial = reportedUsage({ input_tokens: 12, output_tokens: 4 });
  assert.equal(partial?.prompt_tokens_details, undefined);
  assert.equal(aggregateUsage([{}, { input_tokens: 12, output_tokens: 4 }]), null);
});
test('separately reported cache tokens are added exactly once to the OpenAI prompt total', () => {
  assert.deepEqual(reportedUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20,
    cache_creation_input_tokens: 3 }), { prompt_tokens: 33, completion_tokens: 5, total_tokens: 38,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 } });
});
test('stream-event counters can supply usage when the SDK result is zero-filled', () => {
  const t = new Telemetry();
  t.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', usage: {
    input_tokens: 30, output_tokens: 0, cache_read_input_tokens: 70, cache_creation_input_tokens: 0,
  } } } } as unknown as SDKMessage);
  t.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } } as unknown as SDKMessage);
  assert.equal(t.snapshot().normalized_usage_source, 'stream_events');
  assert.equal(t.snapshot().normalized_usage?.completion_tokens, 7);
  assert.equal(t.snapshot().cache_hit_ratio, 0.7);
});
test('Credits exposed only in stream events are preserved independently of zero token counts', () => {
  const t = new Telemetry();
  t.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'credit', usage: {
    input_tokens: 0, output_tokens: 0, credits: 0.025, billable: true,
  } } } } as unknown as SDKMessage);
  assert.equal(t.snapshot().credits, 0.025);
  assert.equal(t.snapshot().request_credits_source, 'stream_events');
  assert.equal(t.snapshot().normalized_usage, null);
});
test('context ratio over the policy window and one-token deltas give exact OpenAI usage', () => {
  assert.deepEqual(measuredUsage([stream()], 1_000_000), { prompt_tokens: 513, completion_tokens: 754,
    total_tokens: 1267, completion_tokens_details: { reasoning_tokens: 455 } });
  assert.equal(measuredUsage([stream()], null), null, 'an unknown window leaves the ratio without a denominator');
  assert.equal(measuredUsage([stream({ contextRatio: null })], 1_000_000), null);
  assert.equal(measuredUsage([stream({ contextRatio: 1.5 })], 1_000_000), null);
  assert.equal(measuredUsage([stream({ maxDeltaChars: 400 })], 1_000_000), null, 'batched upstream chunk');
  assert.equal(measuredUsage([stream({ chars: 754 * 20 })], 1_000_000), null, 'not per-token granularity');
  assert.equal(measuredUsage([stream({ foreignDeltas: 1 })], 1_000_000), null);
});
test('Telemetry measures usage from zero-filled Qoder stream events', () => {
  const t = new Telemetry();
  t.observe(event({ type: 'message_start', message: { id: 'm1', usage: zero } }));
  for (const thinking of ['The', ' user', ' wants'])
    t.observe(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }));
  for (const text of ['O', 'K']) t.observe(event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }));
  t.observe(event({ type: 'message_delta', usage: { ...zero, credits: 0.01, context_usage_ratio: 0.000158 } }));
  t.observe({ type: 'result', subtype: 'success', is_error: false, total_credits: 0.01,
    usage: { ...zero, context_usage_ratio: 0.000158 } } as unknown as SDKMessage);
  const snapshot = t.snapshot(1_000_000);
  assert.equal(snapshot.normalized_usage_source, 'qoder_context_ratio+stream_token_deltas');
  assert.deepEqual(snapshot.normalized_usage, { prompt_tokens: 158, completion_tokens: 5, total_tokens: 163,
    completion_tokens_details: { reasoning_tokens: 3 } });
  assert.equal(snapshot.reasoning_tokens, 3);
  assert.equal(snapshot.cache_usage_status, 'not_reported_by_qoder');
  assert.equal(snapshot.cache_hit_ratio, null);
  assert.equal(t.snapshot().normalized_usage, null);
});
test('text that did not arrive as stream deltas is never counted as tokens', () => {
  const t = new Telemetry();
  t.observe({ type: 'assistant', uuid: 'u', message: { id: 'm', content: [{ type: 'text', text: 'OK' }],
    usage: { ...zero, context_usage_ratio: 0.0002 } } } as unknown as SDKMessage);
  t.observe({ type: 'result', subtype: 'success', is_error: false,
    usage: { ...zero, context_usage_ratio: 0.0002 } } as unknown as SDKMessage);
  assert.equal(t.text, 'OK');
  assert.equal(t.snapshot(1_000_000).normalized_usage, null);
});
test('session-prefix cache estimate is floored to DeepSeek cache units and bounded by the prompt', () => {
  assert.equal(prefixCacheEstimate(513, null), 0);
  assert.equal(prefixCacheEstimate(513, 200), 192);
  assert.equal(prefixCacheEstimate(100, 5000), 64);
  assert.deepEqual(withCachedTokens({ prompt_tokens: 513, completion_tokens: 1, total_tokens: 514 }, 192)
    .prompt_tokens_details, { cached_tokens: 192 });
});
test('SDK API retries surface as bridge status so a silent upstream still shows progress', () => {
  const t = new Telemetry(); const statuses: string[] = [];
  t.observe({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4200, error_status: 503,
    error: 'server_error' } as unknown as SDKMessage, undefined, undefined, text => statuses.push(text));
  assert.deepEqual(statuses, ['[QoderBridge] Qoder upstream retry 2/10 (HTTP 503); next attempt in 4s.']);
  assert.equal(t.snapshot().api_retries, 1);
});
