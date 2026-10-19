import test from 'node:test';
import assert from 'node:assert/strict';
import { QoderPool } from '../src/pool.js';
import { ChatRequest } from '../src/compat.js';
import type { Config } from '../src/client.js';

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', prompt_cache_key: 'guard-session',
  messages: [{ role: 'user', content: 'Plan the next step' }] });
const event = (value: unknown) => ({ type: 'stream_event', session_id: 'sdk', event: value });
const delta = (value: unknown) => event({ type: 'content_block_delta', delta: value });

/** First turn reasons without output until interrupted, as the real SDK ends it: error_during_execution. */
function runawayRecord(thinkingTokens: number) {
  const events: unknown[] = []; const prompts: string[] = []; let turn = 0; let interrupted = false; let interrupts = 0;
  const record = { id: 'guard', messages: [], touched: Date.now(), locked: Promise.resolve(), lastCredits: null, model: 'dfmodel',
    busy: 0, toolSignature: null, retryHint: null, retryMessageHash: null, closed: false, lastSuccessHash: null,
    lastDecision: null, sdkSessionId: null, lastPromptTokens: null, lastFailedDecision: null, lastCompletionId: null,
    policyCalls: [] as unknown[], controller: new AbortController(), warm: { close() {} },
    q: {
      next: async () => {
        if (interrupted) {
          interrupted = false;
          while (events.length && (events.shift() as { type: string }).type !== 'result') { /* drop the rest of the turn */ }
          return { done: false, value: { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sdk',
            terminal_reason: 'aborted_streaming', errors: ['Operation aborted'], total_credits: 0, usage: zero, modelUsage: {} } };
        }
        return { done: false, value: events.shift() };
      },
      interrupt: async () => { interrupts++; interrupted = true; return { still_queued: [] }; },
    },
    queue: { close() {}, push(message: { message: { content: string } }) {
      prompts.push(message.message.content); turn++;
      record.policyCalls.push({ purpose: 'main', model: 'dfmodel', context_window: 1_000_000, reasoning_effort: 'max' });
      if (turn === 1) events.push(event({ type: 'message_start', message: { id: 'm1', usage: zero } }),
        ...Array.from({ length: thinkingTokens }, () => delta({ type: 'thinking_delta', thinking: 'x' })),
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { ...zero, credits: 0.5, context_usage_ratio: 0.0005 } }),
        { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk', total_credits: 0.5, usage: zero, modelUsage: {} });
      else events.push(event({ type: 'message_start', message: { id: `m${turn}`, usage: zero } }),
        delta({ type: 'thinking_delta', thinking: 'ok' }),
        ...['{"kind":"final",', '"content":', '"OK"}'].map(text => delta({ type: 'text_delta', text })),
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { ...zero, credits: 0.02, original_credits: 0.02,
          billable: true, context_usage_ratio: 0.000513 } }),
        { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk', total_credits: 0.02, usage: zero, modelUsage: {} });
    } } };
  return { record, prompts, interrupts: () => interrupts };
}
function poolWith(config: Partial<Config>, record: unknown) {
  const pool = new QoderPool({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test', reasoning: 'max', ...config });
  (pool as unknown as { open: () => Promise<unknown> }).open = async () => record;
  return pool;
}
test('runaway reasoning is interrupted and retried once at high effort in the same Qoder session', async () => {
  const fake = runawayRecord(1100);
  const pool = poolWith({ reasoningGuardTokens: 1024 }, fake.record);
  try {
    const result = await pool.infer(request);
    assert.deepEqual(result.decision, { kind: 'final', content: 'OK' });
    assert.equal(fake.interrupts(), 1);
    assert.equal(result.recovery!.outcome, 'recovered'); assert.equal(result.recovery!.attempts, 2);
    assert.match(fake.prompts[1]!, /stopped after very long reasoning/);
    assert.ok(!fake.prompts[1]!.includes('Plan the next step'), 'the retry does not resend the conversation');
    const report = result.report as Record<string, unknown>;
    assert.equal(report.reasoning_guard_stops, 1);
    assert.equal(report.requested_reasoning, 'high');
    // Final context with all generated output: 1,024+ interrupted thinking plus the retry's 1 thinking + 3 text tokens.
    const usage = report.client_usage as { prompt_tokens: number; completion_tokens: number; completion_tokens_details: { reasoning_tokens: number } };
    assert.equal(usage.prompt_tokens, 513);
    assert.ok(usage.completion_tokens >= 1024 + 4 && usage.completion_tokens <= 1100 + 4);
    assert.equal(usage.completion_tokens_details.reasoning_tokens, usage.completion_tokens - 3);
    assert.equal(pool.stats().sessions, 1, 'an interrupted turn keeps its Qoder session');
    assert.equal(pool.stats().reasoning_guard.trips, 1);
  } finally { pool.closeAll(); }
});
test('the guard can be disabled and never interrupts reasoning that produces output', async () => {
  const fake = runawayRecord(1100);
  const pool = poolWith({ reasoningGuardTokens: 0 }, fake.record);
  try {
    const result = await pool.infer(request);
    assert.equal(fake.interrupts(), 0);
    assert.equal(result.recovery!.outcome, 'empty_response');
  } finally { pool.closeAll(); }
  assert.throws(() => new QoderPool({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test', reasoningGuardTokens: 10 }),
    /reasoningGuardTokens/);
});
test('an identical retry after the reasoning budget is exhausted replays the failure without a new paid loop', async () => {
  const fake = runawayRecord(1100);
  const pool = poolWith({ reasoningGuardTokens: 1024, decisionRetries: 0 }, fake.record);
  try {
    const first = await pool.infer(request);
    assert.equal(first.recovery!.outcome, 'reasoning_budget');
    const again = await pool.infer(request);
    assert.equal(again.report.stage, 'local_rejected_replay');
    assert.equal(fake.prompts.length, 1, 'the identical request did not reach the model again');
  } finally { pool.closeAll(); }
});
