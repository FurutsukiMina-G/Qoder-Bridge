import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest } from '../src/compat.js';
import { taskLogEntry } from '../src/task-log.js';

test('task log groups by hashed Harness key and records useful bounded task data without system text', () => {
  const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', prompt_cache_key: 'session-secret-id',
    messages: [
      { role: 'system', content: 'DO_NOT_LOG_SYSTEM_SECRET' },
      { role: 'user', content: 'Read sentinel.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_x', content: 'SENTINEL_OK' },
    ], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  });
  const record = taskLogEntry({ request, bridgeRequestId: 'bridge-x', startedAt: Date.now(),
    turn: { session_id: 'qoder-x', history_mode: 'delta', sent_message_count: 2,
      credits_delta: 0.02, wall_ms: 1200, prompt_chars: 230, sent_tool_definition_chars: 0,
      tool_definitions_reused: true },
    decision: { kind: 'final', content: 'SENTINEL_OK' } });
  assert.equal(record.harness_session_key_hash?.length, 12);
  assert.equal(record.input.tool_results[0]?.content.excerpt, 'SENTINEL_OK');
  assert.equal(record.input.user_messages.length, 0);
  assert.equal(record.telemetry.credits_delta, 0.02);
  assert.equal(record.output?.kind, 'final');
  const json = JSON.stringify(record);
  assert.ok(!json.includes('session-secret-id'));
  assert.ok(!json.includes('DO_NOT_LOG_SYSTEM_SECRET'));
});
test('a zero-message local replay does not log the whole conversation as a new delta', () => {
  const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'earlier text' }] });
  const row = taskLogEntry({ request, bridgeRequestId: 'local-replay', startedAt: Date.now(),
    turn: { history_mode: 'delta', sent_message_count: 0, local_response_replay: true, credits_delta: 0 } });
  assert.equal(row.input.new_message_count, 0);
  assert.deepEqual(row.input.user_messages, []);
  assert.equal(row.telemetry.credits_delta_source, 'local_replay');
});
