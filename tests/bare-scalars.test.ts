import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest, parseDecision, type DecisionRepair } from '../src/compat.js';
const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object',
    properties: { file_path: { type: 'string' }, limit: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 1 } },
    required: ['file_path', 'limit', 'offset'], additionalProperties: false } } }] });
const source = '<｜｜DSML｜｜ invoke name="read">\n' +
  '<｜｜DSML｜｜ parameter name="file_path" string="true">D:\\project\\中文.cs</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="limit" string="false">80</｜｜DSML｜｜>\n' +
  '<｜｜DSML｜｜ parameter name="offset" string="false">1</｜｜DSML｜｜>\n' +
  '</｜｜DSML｜｜>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('a complete single invocation retains numeric fields with abbreviated parameter closes', () => {
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, request, r => repairs.push(r)),
    { kind: 'tool_call', name: 'read', arguments: { file_path: 'D:\\project\\中文.cs', limit: 80, offset: 1 } });
  assert.deepEqual(repairs, [{ kind: 'missing_calls_opener', tool: 'read', parameter: 'calls' }]);
});

test('abbreviated scalar boundaries reject incomplete, non-primitive, invalid and extra calls', () => {
  for (const invalid of [
    source.replace('>80</', '>8e</'), source.replace('>80</', '>"80"</'),
    source.replace('>80</', '>{"limit":80}</'), source.replace('>80</', '>0</'),
    source.replace('name="read"', 'name="missing"'),
    source.replace('</｜｜DSML｜｜ invoke>', ''), source + source,
  ]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, request, r => repairs.push(r)));
    assert.deepEqual(repairs, []);
  }
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
});

test('JSON argument strings containing abbreviated and invoke closes stay opaque', () => {
  const args = { file_path: 'literal </｜｜DSML｜｜> and </｜｜DSML｜｜ invoke> data', limit: 80, offset: 1 };
  const encoded = '<｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="arguments" string="false">' +
    JSON.stringify(args) + '</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(encoded, request), { kind: 'tool_call', name: 'read', arguments: args });
});
