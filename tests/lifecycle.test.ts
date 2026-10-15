import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestSlots } from '../src/async.js';
import { QoderPool } from '../src/pool.js';
import { ChatRequest } from '../src/compat.js';
import type { Config } from '../src/client.js';

const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', prompt_cache_key: 'test-session',
  messages: [{ role: 'user', content: 'Answer OK' }] });
function fakePool(timeout = 5000, stalled = false, fail = false) {
  const config: Config = { auth: 'cli', timeout, strategy: 'permission', system: 'test' };
  let phase = 0; let prompts = 0; let closed = 0;
  const record = { id: 'fake', messages: [], touched: Date.now(), locked: Promise.resolve(),
    lastCredits: null, model: 'dfmodel', busy: 0, toolSignature: null, retryHint: null, retryMessageHash: null,
    policyCalls: [], controller: new AbortController(), warm: { close() { closed++; } },
    queue: { push() { prompts++; }, close() {} }, q: { next: async () => {
      if (stalled) return await new Promise<never>(() => {});
      if (phase++ % 2 === 0) return { done: false, value: { type: 'assistant', uuid: String(phase), session_id: 'sdk-fake',
        message: { id: String(phase), content: [{ type: 'text', text: '{"kind":"final","content":"OK"}' }],
          usage: { input_tokens: 0, output_tokens: 0 } } } };
      return { done: false, value: { type: 'result', session_id: 'sdk-fake', subtype: fail ? 'error_during_execution' : 'success', is_error: fail,
        total_credits: prompts * 0.1, usage: {}, modelUsage: {} } };
    } } };
  const pool = new QoderPool(config);
  const state = pool as unknown as { nextWarm: Promise<typeof record>; primeNext: () => Promise<typeof record> };
  state.nextWarm = Promise.resolve(record); state.primeNext = () => Promise.resolve(record);
  return { pool, record, counts: () => ({ prompts, closed }) };
}
test('cancelled permit waiters are removed and a release never overbooks concurrency', async () => {
  const slots = new RequestSlots(1); const first = await slots.take();
  const controller = new AbortController(); const pending = slots.take(controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  const second = slots.take(); first(); const release = await second;
  assert.equal(slots.active, 1); assert.equal(slots.queued, 0);
  first(); assert.equal(slots.active, 1); release(); assert.equal(slots.active, 0);
});
test('concurrent duplicate session requests run one model turn and locally replay the answer', async () => {
  const { pool, counts } = fakePool();
  const [a, b] = await Promise.all([pool.infer(request), pool.infer(request)]);
  assert.equal(counts().prompts, 1);
  assert.equal(a.report.credits_delta, 0.1);
  assert.equal(b.report.credits_delta, 0);
  assert.equal(b.report.local_response_replay, true);
  assert.equal(b.report.model_requests, 0);
  assert.equal(b.report.normalized_usage, null);
  await pool.infer({ ...request, messages: [...request.messages, { role: 'user', content: 'Again' }] });
  assert.equal(counts().prompts, 2);
});
test('deadline closes the owned SDK session and returns an auditable failed report', async () => {
  const { pool, record, counts } = fakePool(30, true);
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const turn = await pool.infer(request);
    assert.ok(turn.report.error);
    assert.equal(turn.report.stage, 'cancelled_or_timeout');
    assert.equal(turn.report.credits_delta, null);
    assert.equal(counts().closed, 1);
    assert.equal(record.busy, 0);
  } finally { clearTimeout(keepAlive); }
});
test('human approval waits retain context past twenty minutes but still release expired idle sessions', async () => {
  const { pool, record, counts } = fakePool();
  try {
    await pool.infer(request);
    const internals = pool as unknown as { sweepIdle(): void };
    record.touched = Date.now() - 30 * 60_000;
    internals.sweepIdle();
    assert.equal(counts().closed, 0);
    await pool.infer({ ...request, messages: [...request.messages, { role: 'user', content: 'Approved; continue' }] });
    assert.equal(counts().prompts, 2); assert.equal(pool.stats().sessions, 1);
    record.touched = Date.now() - 61 * 60_000;
    internals.sweepIdle(); assert.equal(counts().closed, 1);
  } finally { pool.closeAll(); }
});
test('idle cleanup never closes a busy session and rejects invalid retention configuration', async () => {
  const { pool, record, counts } = fakePool();
  try {
    await pool.infer(request); record.touched = Date.now() - 61 * 60_000; record.busy = 1;
    (pool as unknown as { sweepIdle(): void }).sweepIdle();
    assert.equal(counts().closed, 0); record.busy = 0;
  } finally { pool.closeAll(); }
  assert.throws(() => new QoderPool({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test', sessionIdleMs: NaN }), /sessionIdleMs/);
});
test('SDK failure retains reported Credits instead of losing its whole telemetry record', async () => {
  const { pool, counts } = fakePool(5000, false, true);
  const result = await pool.infer(request);
  assert.match(result.report.error!, /error_during_execution/);
  assert.equal(result.report.credits_delta, 0.1);
  assert.equal(result.decision, null);
  assert.equal(counts().closed, 1);
});
test('cancelling a queued same-session request does not terminate its active predecessor', async () => {
  const { pool, counts } = fakePool(2000, true);
  const owner = new AbortController(); const queued = new AbortController();
  const active = pool.infer(request, { signal: owner.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  const waiting = pool.infer(request, { signal: queued.signal });
  queued.abort(new Error('queued cancelled'));
  await assert.rejects(waiting, /queued cancelled/);
  assert.equal(counts().closed, 0);
  owner.abort(new Error('owner cancelled'));
  await active;
  assert.equal(counts().closed, 1);
});

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
/** Fake SDK session that streams like Qoder: zero token fields, a context ratio, one delta per token. */
function streamingRecord(id: string, ratios: number[]) {
  const events: unknown[] = []; let turn = 0;
  const policyCalls: Array<{ purpose: string; model: string; context_window: number | null; reasoning_effort: string | null }> = [];
  const delta = (delta: unknown) => ({ type: 'stream_event', session_id: 'sdk', event: { type: 'content_block_delta', delta } });
  const record = { id, messages: [], touched: Date.now(), locked: Promise.resolve(), lastCredits: null, model: 'dfmodel',
    busy: 0, toolSignature: null, retryHint: null, retryMessageHash: null, policyCalls, closed: false,
    lastSuccessHash: null, lastDecision: null, sdkSessionId: null, lastPromptTokens: null,
    controller: new AbortController(), warm: { close() {} }, q: { next: async () => ({ done: false, value: events.shift() }) },
    queue: { close() {}, push() {
      const ratio = ratios[turn++]!;
      policyCalls.push({ purpose: 'main', model: 'dfmodel', context_window: 1_000_000, reasoning_effort: 'max' });
      events.push({ type: 'stream_event', session_id: 'sdk', event: { type: 'message_start', message: { id: `${id}-${turn}`, usage: zero } } },
        delta({ type: 'thinking_delta', thinking: 'Hm' }),
        ...['{"kind":"final",', '"content":', '"OK"}'].map(text => delta({ type: 'text_delta', text })),
        { type: 'stream_event', session_id: 'sdk', event: { type: 'message_delta', usage: { ...zero, credits: 0.01, context_usage_ratio: ratio } } },
        { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk', total_credits: 0.01 * turn,
          usage: { ...zero, context_usage_ratio: ratio }, modelUsage: {} });
    } } };
  return record;
}
function streamingPool(cacheUsage: Config['cacheUsage'], ratios: number[]) {
  const pool = new QoderPool({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test', cacheUsage });
  const opened: Array<ReturnType<typeof streamingRecord>> = [];
  (pool as unknown as { open: () => Promise<unknown> }).open = async () => {
    const record = streamingRecord(`fake-${opened.length}`, ratios); opened.push(record); return record;
  };
  return { pool, opened };
}
const next = (text: string) => ({ ...request, messages: [...request.messages, { role: 'assistant' as const, content: 'OK' },
  { role: 'user' as const, content: text }] });
test('measured usage reaches the client; cached tokens are sent only when the estimate is enabled', async () => {
  const plain = streamingPool('none', [0.00923, 0.009415]);
  const first = await plain.pool.infer(request);
  assert.deepEqual(first.report.client_usage, { prompt_tokens: 9230, completion_tokens: 4, total_tokens: 9234,
    completion_tokens_details: { reasoning_tokens: 1 } });
  const second = await plain.pool.infer(next('Again'));
  assert.equal(second.report.cache_estimate_tokens, 9216, 'logged for analysis even when not sent');
  assert.equal(second.report.client_usage?.prompt_tokens_details, undefined);
  assert.equal(second.report.client_cache_usage, 'omitted');
  plain.pool.closeAll();

  const estimated = streamingPool('estimate', [0.00923, 0.009415]);
  await estimated.pool.infer(request);
  const continued = await estimated.pool.infer(next('Again'));
  assert.deepEqual(continued.report.client_usage?.prompt_tokens_details, { cached_tokens: 9216 });
  assert.equal(continued.report.client_cache_usage, 'session_prefix_estimate');
  const replay = await estimated.pool.infer(next('Again'));
  assert.equal(replay.report.local_response_replay, true);
  assert.deepEqual(replay.report.client_usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  estimated.pool.closeAll();
});
test('a diverged history for the same client key closes the unreachable Qoder session', async () => {
  const { pool, opened } = streamingPool('none', [0.001, 0.001]);
  await pool.infer(request);
  await pool.infer({ ...request, messages: [{ role: 'user', content: 'A different branch' }] });
  const first = opened[0]!; const replacement = opened.find(record => record !== first && !record.closed);
  assert.equal(first.closed, true);
  assert.ok(replacement);
  assert.equal(pool.stats().sessions, 1);
  pool.closeAll();
});
