import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo, SDKMessage, CanUseTool } from '@qodercn-ai/qodercn-agent-sdk';
import { selectModel } from '../src/model.js';
import { InputQueue } from '../src/queue.js';
import { Telemetry, safeError } from '../src/telemetry.js';
import { Interceptor, evaluateGate } from '../src/interceptor.js';
import { baseOptions, type Config } from '../src/client.js';
import { auditHistory } from '../src/history.js';
import { parseAction } from '../src/action.js';

const model: ModelInfo = { value: 'runtime-deepseek-flash-id', displayName: 'DeepSeek Flash', description: '', isEnabled: true,
  context_config: { '200K': { token_count: 200000 } }, thinking_config: { enabled: { efforts: { high: {} } } } };
test('runtime selection refuses absent, disabled, ambiguous models and unsupported parameters', () => {
  assert.equal(selectModel([model], {}).model, model.value);
  assert.throws(() => selectModel([], {}));
  assert.throws(() => selectModel([{ ...model, isEnabled: false }], {}));
  assert.throws(() => selectModel([model, { ...model, value: 'second' }], {}));
  assert.throws(() => selectModel([model], { context: 1000000 }));
  assert.throws(() => selectModel([model], { reasoning: 'max' }));
  assert.deepEqual(selectModel([model], { context: 200000, reasoning: 'high' }).parameters,
    { contextWindow: 200000, reasoningEffort: 'high' });
});
test('queue waits without submitting a fake prompt, closes pending consumer', async () => {
  const queue = new InputQueue<number>();
  const it = queue[Symbol.asyncIterator]();
  const first = it.next(); queue.push(7);
  assert.deepEqual(await first, { done: false, value: 7 });
  const last = it.next(); queue.close();
  assert.equal((await last).done, true);
  assert.throws(() => queue.push(8));
});
function assistant(id: string, credits?: number): SDKMessage {
  return { type: 'assistant', uuid: id, session_id: 'session', parent_tool_use_id: null,
    request_id: id, message: { role: 'assistant', id, content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 12, output_tokens: 1, ...(credits === undefined ? {} : { credits }) } } };
}
test('telemetry deduplicates request usage and does not turn missing credits into zero', () => {
  const t = new Telemetry();
  assert.equal(t.snapshot().credits, null);
  t.observe(assistant('a', 0.2)); t.observe(assistant('a', 0.2));
  assert.equal(t.snapshot().credits, 0.2);
  assert.equal(t.snapshot().model_requests, 1);
  t.observe(assistant('b'));
  assert.equal(t.snapshot().model_requests, 2);
  assert.equal(t.snapshot().credits, null);
  assert.equal(t.snapshot().input_tokens, 24);
});
test('stream deltas and final assistant are not printed twice', () => {
  const t = new Telemetry(); let output = '';
  t.observe({ type: 'stream_event', uuid: 's', session_id: 'session', parent_tool_use_id: null,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } }, x => { output += x; });
  t.observe(assistant('a', 0), x => { output += x; });
  assert.equal(output, 'OK'); assert.equal(t.snapshot().credits, 0); assert.notEqual(t.ttft_ms, null);
});
test('zero-filled token counters are explicitly marked unreliable', () => {
  const t = new Telemetry();
  const message = assistant('zero');
  if (message.type === 'assistant') message.message.usage = { input_tokens: 0, output_tokens: 0 };
  t.observe(message);
  assert.equal(t.snapshot().token_usage_status, 'zero_filled_unreliable');
});
test('permission interception denies and interrupts with original tool ID', async () => {
  const i = new Interceptor('permission');
  const decision = await i.canUseTool('mcp__bridge__read_file', { path: 'a.ts' },
    { signal: new AbortController().signal, toolUseID: 'tool1' } as Parameters<CanUseTool>[2]);
  assert.equal(decision.behavior, 'deny');
  assert.ok('interrupt' in decision && decision.interrupt);
  assert.equal(i.calls[0]?.tool_use_id, 'tool1'); assert.equal(i.handlerInvocations, 0);
});
test('gate fails for retry, handler entry, missing terminal/credits, wrong args, timeout', () => {
  const i = new Interceptor('permission'); i.capture('mcp__bridge__read_file', { path: 'a.ts' }, 't', 'canUseTool');
  const good = { expectedPath: 'a.ts', requests: 1, policyCalls: 1, retries: 0, completed: true, credits: 0.2, timedOut: false };
  assert.equal(evaluateGate(i, good).interception_passed, true);
  assert.equal(evaluateGate(i, good).phase2_ready, false);
  assert.equal(evaluateGate(i, { ...good, credits: null }).behavior_passed, true);
  for (const change of [{ requests: 2 }, { policyCalls: 2 }, { retries: 1 }, { completed: false },
    { credits: null }, { requests: null }, { timedOut: true }, { expectedPath: 'b.ts' }, { error: 'failure' }]) {
    assert.equal(evaluateGate(i, { ...good, ...change }).interception_passed, false);
  }
  i.handlerInvocations = 1;
  assert.equal(evaluateGate(i, good).interception_passed, false);
});
test('defer strategy uses the public defer decision without injecting a deny message', async () => {
  const i = new Interceptor('defer');
  const response = await i.beforeTool({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '.', transcript_path: '',
    tool_name: 'mcp__bridge__read_file', tool_input: { path: 'a' }, tool_use_id: 't' }, 't', { signal: new AbortController().signal });
  assert.deepEqual(response, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } });
  assert.equal(i.calls[0]?.source, 'PreToolUse');
});
test('thin session disables inherited behavior and uses CN official authentication', () => {
  const config: Config = { auth: 'cli', timeout: 10000, system: 'test prompt', strategy: 'permission' };
  const options = baseOptions(config, new AbortController());
  for (const key of ['tools', 'skills', 'settingSources', 'plugins'] as const) assert.deepEqual(options[key], []);
  assert.equal(options.systemPrompt, 'test prompt'); assert.equal(options.maxTurns, 1);
  assert.equal(options.strictMcpConfig, true); assert.equal(options.auth?.type, 'qodercli');
  assert.equal(options.env?.USERPROFILE, process.env.USERPROFILE);
  // Windows preserves the spelling of Path while process.env lookup is
  // case-insensitive; spreading it into a plain object loses that lookup.
  const childPath = Object.entries(options.env ?? {}).find(([key]) =>
    process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')?.[1];
  assert.equal(childPath, process.env.PATH);
  assert.equal(options.env?.QODERCN_EXPOSE_REQUEST_ID, 'true');
});
test('errors redact configured secrets', () => {
  process.env.QODERCN_PERSONAL_ACCESS_TOKEN = 'test-secret';
  try { assert.equal(safeError(new Error('bad test-secret Bearer abc')), 'bad [REDACTED] Bearer [REDACTED]'); }
  finally { delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN; }
});
test('history audit rejects inserted denial results and duplicate host results', () => {
  const call = { type: 'assistant', uuid: 'a', session_id: 's', parent_tool_use_id: null, parent_agent_id: null,
    message: { content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a' } }] } } as const;
  const result = { type: 'user', uuid: 'u', session_id: 's', parent_tool_use_id: null, parent_agent_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'HOST_RESULT' }] } } as const;
  assert.equal(auditHistory([], ['t']).session_history_clean, 'not_verified');
  assert.equal(auditHistory([call, result], ['t']).session_history_clean, 'no_contamination_observed');
  assert.equal(auditHistory([call, result, result], ['t']).session_history_clean, 'failed');
  assert.equal(auditHistory([call, { ...result, tool_result_meta: [{ id: 't', non_execution_kind: 'interrupted' }] }], ['t']).session_history_clean, 'failed');
});
test('action protocol accepts only known actions and rejects extra or malformed data', () => {
  assert.deepEqual(parseAction('{"action":"read_file","arguments":{"path":"a.ts"}}'), { action: 'read_file', arguments: { path: 'a.ts' } });
  assert.equal(parseAction('```json\n{"action":"finish","arguments":{"message":"done"}}\n```').action, 'finish');
  for (const invalid of ['{}', '{"action":"shell","arguments":{"command":"whoami"}}',
    '{"action":"read_file","arguments":{"path":""}}', '{"action":"read_file","arguments":{"path":"a","extra":true}}',
    'prose {"action":"finish","arguments":{"message":"done"}}']) assert.throws(() => parseAction(invalid));
});
