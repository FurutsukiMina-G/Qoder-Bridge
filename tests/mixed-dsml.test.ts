import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest, parseDecision, type DecisionRepair } from '../src/compat.js';

const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
  tools: [
    { type: 'function', function: { name: 'grep', parameters: { type: 'object',
      properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false } } },
    { type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  ] });
const calls = '<｜｜DSML｜｜ parameter name="calls" string="false">' +
  '[{"name":"grep","arguments":{"pattern":"second"}}]</｜｜DSML｜｜ parameter>';

test('a calls array never discards a preceding complete parameter-form call', () => {
  const source = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="grep">' +
    '<｜｜DSML｜｜ parameter name="pattern" string="true">first</｜｜DSML｜｜ parameter>' +
    '</｜｜DSML｜｜ invoke>' + calls + '</｜｜DSML｜｜ calls>';
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision(source, request, repair => repairs.push(repair)));
  assert.deepEqual(repairs, []);
});

test('a calls array never reinterprets a supplied zero-argument tool as its wrapper', () => {
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="noop">' +
    calls + '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', request, repair => repairs.push(repair)));
  assert.deepEqual(repairs, []);
  assert.deepEqual(parseDecision('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="tool_calls">' +
    calls + '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', request),
    { kind: 'tool_call', name: 'grep', arguments: { pattern: 'second' } });
});
