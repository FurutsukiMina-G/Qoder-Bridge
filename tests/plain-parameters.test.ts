import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest, parseDecision, type DecisionRepair } from '../src/compat.js';

const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'], additionalProperties: false } } }] });
const envelope = (content: string) => '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write">\n' +
  '<parameter name="file_path">D:\\project\\doc.md</parameter>\n' +
  `<parameter name="content">${content}</parameter>\n</invoke>\n` +
  '</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('recorded plain write fields retain exact Unicode, whitespace, quotes and protocol-looking data', () => {
  const content = '  # 中文\r\n{"kind":"tool_call","name":"unknown"}\n' +
    '<｜｜DSML｜｜ invoke name="unknown">literal</｜｜DSML｜｜ invoke>\n&unescaped;  ';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(envelope(content), request, r => repairs.push(r)),
    { kind: 'tool_call', name: 'write', arguments: { file_path: 'D:\\project\\doc.md', content } });
  assert.deepEqual(repairs, [{ kind: 'plain_write_parameters', tool: 'write', parameter: 'arguments' }]);
  assert.equal(parseDecision(envelope(''), request).kind, 'tool_call');
});

test('plain write recovery rejects truncated fields, duplicate parameters and additional calls', () => {
  const source = envelope('complete');
  for (const invalid of [
    source.replace('complete</parameter>', 'cut'),
    source.replace('</invoke>', '<parameter name="content">other</parameter></invoke>'),
    source.replace('<parameter name="file_path">', '<parameter name="unknown">'),
    source.replace('<parameter name="content">', '<parameter name="content" string="false">'),
    source.replace('</｜｜DSML｜｜ calls>', '</｜｜DSML｜｜ tool_calls>'),
    source.replace('</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>', '</｜｜DSML｜｜ invoke>'),
    source + source,
    source + '{"kind":"tool_call","name":"unknown","arguments":{}}',
  ]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, request, r => repairs.push(r)));
    assert.deepEqual(repairs, []);
  }
});

test('plain write recovery still enforces supplied schemas and tool selection', () => {
  const source = envelope('value');
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tools: [] })));
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request,
    tool_choice: { type: 'function', function: { name: 'other' } } })), /unselected/);
  const constrained = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: { name: 'write', parameters: {
    type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string', enum: ['different'] } },
    required: ['file_path', 'content'], additionalProperties: false,
  } } }] });
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision(source, constrained, r => repairs.push(r)), /violate/);
  assert.deepEqual(repairs, []);
});
