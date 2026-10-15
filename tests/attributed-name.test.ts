import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest, parseDecision, type DecisionRepair } from '../src/compat.js';
const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'grep', parameters: { type: 'object',
    properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false } } }] });
const envelope = (args: unknown, name = 'grep') => '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="tool_call">' +
  '<｜｜DSML｜｜ parameter name="arguments" string="false">' + JSON.stringify(args) +
  '</｜｜DSML｜｜ parameter>' + `<｜｜DSML｜｜ name="${name}"｜｜DSML｜｜ parameter>` +
  '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';

test('explicit attributed shorthand name after complete arguments preserves all argument text', () => {
  const args = { pattern: '中文 "quote"\n<｜｜DSML｜｜ name="other"｜｜DSML｜｜ parameter> literal' };
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(envelope(args), request, r => repairs.push(r)),
    { kind: 'tool_call', name: 'grep', arguments: args });
  assert.deepEqual(repairs, [{ kind: 'generic_shorthand_name', tool: 'grep', parameter: 'name' }]);
});

test('attributed names require the full single-call envelope and never drop extra data', () => {
  const source = envelope({ pattern: 'complete' });
  for (const invalid of [
    source.replace('{"pattern":"complete"}', '{"pattern":"cut'),
    source.replace('name="grep"', 'name="missing"'),
    source.replace('name="grep"', 'name="grep'),
    source.replace('</｜｜DSML｜｜ invoke>', ''),
    source.replace('</｜｜DSML｜｜ calls>', '</｜｜DSML｜｜ tool_calls>'),
    source + source,
    source + '{"kind":"tool_call","name":"grep","arguments":{"pattern":"extra"}}',
  ]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, request, r => repairs.push(r)));
    assert.deepEqual(repairs, []);
  }
});

test('attributed names retain normal schema, wrapper-collision and tool-choice validation', () => {
  assert.throws(() => parseDecision(envelope({ pattern: 12 }), request), /violate/);
  assert.throws(() => parseDecision(envelope({}), request), /pattern/);
  assert.throws(() => parseDecision(envelope({ pattern: 'ok' }), ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(envelope({ pattern: 'ok' }), ChatRequest.parse({ ...request,
    tool_choice: { type: 'function', function: { name: 'other' } } })), /unselected/);
  assert.throws(() => parseDecision(envelope({ pattern: 'ok' }), ChatRequest.parse({ ...request,
    tools: [...request.tools!, { type: 'function', function: { name: 'tool_call', parameters: { type: 'object' } } }] })), /conflicts/);
});
