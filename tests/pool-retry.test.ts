import test from 'node:test';
import assert from 'node:assert/strict';
import { QoderPool } from '../src/pool.js';
import { ChatRequest } from '../src/compat.js';
import type { Config } from '../src/client.js';

test('a rejected model decision keeps the Harness message pending for the next retry', async () => {
  const config: Config = { auth: 'cli', timeout: 30000, strategy: 'permission', system: 'test' };
  const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', prompt_cache_key: 'session-test',
    messages: [{ role: 'user', content: 'Read the fixture' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
      additionalProperties: false,
    } } }],
  });
  const prompts: string[] = [];
  const outputs = ['{"kind":"tool_call","name":"read_file","arguments":',
    '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}'];
  let turn = 0; let phase = 0;
  const q = { next: async () => {
    if (phase++ % 2 === 0) return { done: false, value: { type: 'assistant', uuid: `a${turn}`,
      message: { id: `m${turn}`, model: 'dfmodel', content: [{ type: 'text', text: outputs[turn] }],
        usage: { input_tokens: 0, output_tokens: 0, credits: 0.1 } } } };
    turn++;
    return { done: false, value: { type: 'result', subtype: 'success', is_error: false,
      total_credits: turn * 0.1, modelUsage: {}, usage: {}, duration_ms: 20, duration_api_ms: 15 } };
  } };
  const record = { id: 'qoder-session-test', q, queue: { push: (item: { message: { content: string } }) =>
    prompts.push(item.message.content) }, messages: [], touched: Date.now(), locked: Promise.resolve(),
    lastCredits: null, model: 'dfmodel', busy: 0, toolSignature: null, retryHint: null,
    policyCalls: [], warm: { close() {} }, controller: new AbortController() };
  const pool = new QoderPool(config);
  const injected = pool as unknown as { nextWarm: Promise<typeof record>; primeNext: () => Promise<typeof record> };
  injected.nextWarm = Promise.resolve(record);
  injected.primeNext = () => Promise.resolve(record);

  const failed = await pool.infer(request);
  assert.ok(failed.decisionError);
  assert.equal(failed.report.credits_delta, 0.1);
  assert.equal(record.messages.length, 0);
  const recovered = await pool.infer(request);
  assert.deepEqual(recovered.decision, { kind: 'tool_call', name: 'read_file',
    arguments: { path: 'fixture.txt' } });
  assert.equal(recovered.report.sent_message_count, 1);
  assert.match(prompts[1]!, /Read the fixture/);
  assert.match(prompts[1]!, /preceding model decision was rejected/);
  assert.equal(record.messages.length, 1);
});
