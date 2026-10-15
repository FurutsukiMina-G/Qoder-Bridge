import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { ChatRequest, parseDecision, type DecisionRepair } from '../src/compat.js';
import { Telemetry } from '../src/telemetry.js';
import { createBridgeServer } from '../src/server.js';
import type { runProbe } from '../src/client.js';

const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
  tools: [{ type: 'function', function: { name: 'edit', parameters: {
    type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    required: ['file_path', 'old_string', 'new_string'], additionalProperties: false,
  } } }, { type: 'function', function: { name: 'grep', parameters: {
    type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'], additionalProperties: false,
  } } }],
});
const wrap = (tool: string, body: string) => `<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${tool}">\n${body}\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
const editBody = '<｜｜DSML｜｜ parameter name="file_path" string="true">file.py</｜｜DSML｜｜ parameter name="old_string" string="true">if closed:\n    break</｜｜DSML｜｜ parameter>\n' +
  '<｜｜DSML｜｜ parameter name="new_string" string="true">if closed:\n    return</｜｜DSML｜｜ parameter>';
const encodedRequest = ChatRequest.parse({ ...request, tools: [...request.tools!, { type: 'function', function: {
  name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'], additionalProperties: false },
} }] });
const readRequest = ChatRequest.parse({ ...request, tools: [...request.tools!, { type: 'function', function: {
  name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
    required: ['file_path'], additionalProperties: false },
} }] });

const unwrappedCallsParameter = (calls: unknown) => '<｜｜DSML｜｜ parameter name="calls" string="false">' +
  JSON.stringify(calls) + '</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

const genericShorthandName = (name: string, args: unknown) => '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="tool_call">' +
  `<｜｜DSML｜｜ parameter name="arguments" string="false">${JSON.stringify(args)}</｜｜DSML｜｜ parameter>` +
  `<｜｜DSML｜｜name" string="true">${name}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ calls>`;

test('a generic call reads its explicit shorthand name only after complete JSON arguments', () => {
  const args = { file_path: 'app.csproj', content: '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n' };
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision('Write the project.\n' + genericShorthandName('write', args), encodedRequest, repair => repairs.push(repair)),
    { kind: 'tool_call', name: 'write', arguments: args });
  assert.deepEqual(repairs, [{ kind: 'generic_shorthand_name', tool: 'write', parameter: 'name' }]);
});

test('generic shorthand names cannot complete arguments, discard extra calls or bypass schema and choice', () => {
  const source = genericShorthandName('grep', { pattern: 'query' });
  for (const invalid of [source + 'extra', source.replace('</｜｜DSML｜｜ calls>', ''),
    source.replace('{"pattern":"query"}', '{"pattern":"cut'),
    source.replace('string="true">grep', 'string="false">grep'),
    source.replace('>grep</', '>grep</｜｜DSML｜｜ parameter><｜｜DSML｜｜name" string="true">edit</')]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, request, repair => repairs.push(repair)));
    assert.deepEqual(repairs, []);
  }
  assert.throws(() => parseDecision(genericShorthandName('unknown', {}), request), /Unknown/);
  assert.throws(() => parseDecision(genericShorthandName('grep', {}), request), /pattern/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request,
    tool_choice: { type: 'function', function: { name: 'edit' } } })), /unselected/);
});

test('shorthand-looking or canonical tool names inside JSON remain opaque file data', () => {
  const content = '<｜｜DSML｜｜ parameter name="name" string="true">grep</｜｜DSML｜｜ parameter>' +
    '<｜｜DSML｜｜name" string="true">unknown</｜｜DSML｜｜ parameter>';
  const source = genericShorthandName('write', { file_path: 'literal.txt', content });
  assert.deepEqual(parseDecision(source, encodedRequest), { kind: 'tool_call', name: 'write', arguments: { file_path: 'literal.txt', content } });
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'final', content: source }), request), { kind: 'final', content: source });
  const conflict = ChatRequest.parse({ ...encodedRequest, tools: [...encodedRequest.tools!,
    { type: 'function', function: { name: 'tool_call', parameters: { type: 'object' } } }] });
  assert.throws(() => parseDecision(source, conflict), /conflicts/);
});

test('a complete calls parameter without opening wrappers preserves the entire batch and literal marker data', () => {
  const pattern = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="unknown"> literal ' +
    '{"kind":"final","content":"example"} <｜｜DS｜｜tool_calls｜｜DS｜｜';
  const calls = [{ name: 'grep', arguments: { pattern } }, { name: 'grep', arguments: { pattern: '中文' } }];
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision('Use both searches.\n' + unwrappedCallsParameter(calls), request, repair => repairs.push(repair)),
    { kind: 'tool_calls', calls });
  assert.deepEqual(repairs, [{ kind: 'missing_calls_parameter_wrapper', tool: 'wrapper', parameter: 'calls' }]);
  assert.deepEqual(parseDecision(unwrappedCallsParameter([calls[1]]), request), { kind: 'tool_call', ...calls[1] });
});

test('unwrapped calls parameters reject incomplete boundaries and validate every call before reporting repair', () => {
  const source = unwrappedCallsParameter([{ name: 'grep', arguments: { pattern: 'first' } }, { name: 'grep', arguments: { pattern: 'second' } }]);
  for (const invalid of [source + 'extra', source.replace(/<\/｜｜DSML｜｜ calls>$/, ''),
    source.replace('}]</｜｜DSML', '}</｜｜DSML'), source.replace('string="false"', 'string="true"'),
    source.replace('"pattern":"second"', '"unknown":"second"'), unwrappedCallsParameter([])]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, request, repair => repairs.push(repair)));
    assert.deepEqual(repairs, []);
  }
  assert.throws(() => parseDecision(source.replace('"name":"grep"', '"name":"unknown"'), request), /Unknown/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request,
    tool_choice: { type: 'function', function: { name: 'edit' } } })), /unselected/);
});

test('outer JSON keeps a literal unwrapped calls parameter as content', () => {
  const content = unwrappedCallsParameter([{ name: 'grep', arguments: { pattern: 'example' } }]);
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'final', content }), request), { kind: 'final', content });
  const malformed = unwrappedCallsParameter([{ name: 'grep', arguments: {
    pattern: '{"kind":"tool_call","name":"grep","arguments":{"pattern":"embedded"}}',
  } }]).replace(/<\/｜｜DSML｜｜ calls>$/, '');
  assert.throws(() => parseDecision(malformed, request));
});

test('a missing DSML outer opener preserves one complete write with an explicit outer close', () => {
  const content = '    Write-Output "quoted"\n$path = "D:\\fixture"\n';
  const body = '<｜｜DSML｜｜ invoke name="write">\n' +
    '<｜｜DSML｜｜ parameter name="file_path" string="true">build.ps1</｜｜DSML｜｜ parameter>\n' +
    `<｜｜DSML｜｜ parameter name="content" string="true">${content}</｜｜DSML｜｜ parameter>\n` +
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ tool_calls>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision('I will fix the build.\n' + body, encodedRequest, repair => repairs.push(repair)), {
    kind: 'tool_call', name: 'write', arguments: { file_path: 'build.ps1', content },
  });
  assert.deepEqual(repairs, [{ kind: 'missing_calls_opener', tool: 'write', parameter: 'calls' }]);
});

test('a missing opener cannot discard calls, finish values, ignore extra data or bypass tool validation', () => {
  const call = '<｜｜DSML｜｜ invoke name="grep"><｜｜DSML｜｜ parameter name="pattern" string="true">query</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
  const close = '</｜｜DSML｜｜ tool_calls>';
  for (const source of [call, call + call + close, call + close + 'extra',
    call.replace('query</｜｜DSML｜｜ parameter>', 'incomplete'), call.replace('name="pattern"', 'name="unknown"') + close]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(source, request, repair => repairs.push(repair)));
    assert.deepEqual(repairs, []);
  }
  assert.throws(() => parseDecision(call.replace('name="grep"', 'name="unknown"') + close, request), /Unknown/);
  assert.throws(() => parseDecision(call + close, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(call + close, ChatRequest.parse({ ...request,
    tool_choice: { type: 'function', function: { name: 'edit' } } })), /unselected/);
});

test('JSON decision examples inside a missing-opener write remain file contents', () => {
  const content = '{"kind":"tool_call","name":"grep","arguments":{"pattern":"example"}}';
  const source = '<｜｜DSML｜｜ invoke name="write">' +
    '<｜｜DSML｜｜ parameter name="file_path" string="true">example.json</｜｜DSML｜｜ parameter>' +
    `<｜｜DSML｜｜ parameter name="content" string="true">${content}</｜｜DSML｜｜ parameter>` +
    '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ tool_calls>';
  assert.deepEqual(parseDecision(source, encodedRequest), { kind: 'tool_call', name: 'write',
    arguments: { file_path: 'example.json', content } });
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'final', content: source }), request), { kind: 'final', content: source });
  assert.throws(() => parseDecision(source.replace('</｜｜DSML｜｜ tool_calls>', ''), encodedRequest));
});

test('explicitly named flat calls retain declared arguments and order in single and batch decisions', () => {
  const calls=[{name:'read',file_path:'file.py',offset:10},{name:'grep',pattern:'verified'}];
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(JSON.stringify({kind:'tool_calls',calls}),readRequest,r=>repairs.push(r)),{
    kind:'tool_calls',calls:[{name:'read',arguments:{file_path:'file.py',offset:10}},{name:'grep',arguments:{pattern:'verified'}}],
  });
  assert.deepEqual(repairs.map(r=>r.kind),['flat_call_arguments','flat_call_arguments']);
  assert.deepEqual(parseDecision(JSON.stringify({kind:'tool_call',...calls[0]}),readRequest),{
    kind:'tool_call',name:'read',arguments:{file_path:'file.py',offset:10},
  });
});
test('a sole tool_calls envelope preserves explicit callees, encoded arguments and full schema checks', () => {
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(JSON.stringify({tool_calls:[{name:'grep',arguments:{pattern:'first'}},
    {name:'grep',arguments:'{"pattern":"second"}'}]}),request,r=>repairs.push(r)),{
    kind:'tool_calls',calls:[{name:'grep',arguments:{pattern:'first'}},{name:'grep',arguments:{pattern:'second'}}],
  });
  assert.deepEqual(repairs.map(r=>r.kind),['tool_calls_envelope','encoded_arguments']);
});
test('flat calls and envelopes reject unknown fields, missing values, conflicting name inputs and forbidden tools', () => {
  for(const call of [{name:'read',unknown:true},{name:'read',offset:10},{name:'read',file_path:'file.py',offset:'10'},
    {name:'unknown',file_path:'file.py'}])assert.throws(()=>parseDecision(JSON.stringify({kind:'tool_calls',calls:[call]}),readRequest));
  for(const source of [{tool_calls:[]},{tool_calls:[{name:'grep',arguments:{}}]},
    {tool_calls:[{name:'grep',arguments:{pattern:'x'}}],extra:true}])assert.throws(()=>parseDecision(JSON.stringify(source),request));
  const repairs:DecisionRepair[]=[];
  assert.throws(()=>parseDecision(JSON.stringify({kind:'tool_calls',calls:[{name:'grep',pattern:'valid'},
    {name:'edit',file_path:'file.py'}]}),request,r=>repairs.push(r)),/old_string|schema/);
  assert.deepEqual(repairs,[]);
  assert.throws(()=>parseDecision('{"tool_calls":[{"name":"grep","pattern":"x"}]}',ChatRequest.parse({...request,tool_choice:'none'})),/forbids/);
  const conflict=ChatRequest.parse({...request,tools:[{type:'function',function:{name:'label',parameters:{type:'object',
    properties:{name:{type:'string'}},required:['name']}}}]});
  assert.throws(()=>parseDecision('{"kind":"tool_calls","calls":[{"name":"label"}]}',conflict));
});
const dsField = (name: string, value: string, flag = '') =>
  `<｜｜DS｜｜parameter name="${name}"${flag}｜｜DS｜｜>${value}<｜｜DS｜｜/parameter｜｜DS｜｜`;
const dsInvoke = (name: string, fields: string) => `<｜｜DS｜｜invoke name="${name}"｜｜DS｜｜\n${fields}\n｜｜DS｜｜/invoke｜｜DS｜｜`;
const dsCalls = (body: string) => `<｜｜DS｜｜tool_calls｜｜DS｜｜\n${body}\n｜｜DS｜｜/tool_calls｜｜DS｜｜`;
const repeatedField = (name: string, value: string) => `<｜｜DSML｜｜parameter name="${name}"｜｜DSML｜｜>${value}</｜｜DSML｜｜parameter>`;
const repeatedCall = (fields: string) => `<｜｜DSML｜｜invoke name="pwsh"｜｜DSML｜｜\n${fields}\n<｜｜/DSML｜｜invoke｜｜DSML｜｜`;
const repeatedCalls = (body: string) => `<｜｜DSML｜｜tool_calls｜｜DSML｜｜\n${body}\n<｜｜/DSML｜｜tool_calls｜｜DSML｜｜`;
const pwshRequest = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: {
  name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' },
    description: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['command', 'description'], additionalProperties: false },
} }] });

test('repeated DSML delimiters preserve both complete PowerShell calls and a bounded final path close', () => {
  const first = { command: 'Get-Content -LiteralPath "file.py"', description: 'Inspect existing configuration', workdir: 'D:\\test' };
  const second = { command: 'Get-ChildItem\nGet-Date', description: 'Check working directory', workdir: 'D:\\test' };
  const fields = (args: typeof first) => Object.entries(args).map(([name, value]) => repeatedField(name, value)).join('\n');
  const source = '先核对进度。\n' + repeatedCalls(repeatedCall(fields(first)) + repeatedCall(fields(second)
    .replace('D:\\test</｜｜DSML｜｜parameter>', 'D:\\test｜｜DSML｜｜parameter>')));
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, pwshRequest, repair => repairs.push(repair)), { kind: 'tool_calls', calls: [
    { name: 'pwsh', arguments: first }, { name: 'pwsh', arguments: second },
  ] });
  assert.deepEqual(repairs.map(repair => repair.kind), ['repeated_dsml', 'misclosed_parameter', 'repeated_dsml']);
});

test('repeated DSML malformed path recovery cannot invent missing values or bypass schema and choice', () => {
  const fields = repeatedField('command', 'Get-Date') + repeatedField('description', 'Check current time');
  for (const extra of [
    '<｜｜DSML｜｜parameter name="workdir"｜｜DSML｜｜>D:\\test',
    '<｜｜DSML｜｜parameter name="workdir"｜｜DSML｜｜>relative｜｜DSML｜｜parameter>',
    '<｜｜DSML｜｜parameter name="workdir"｜｜DSML｜｜>D:\\test｜｜DSML｜｜parameter>unexpected',
    repeatedField('timeoutMs', '"1000"'), repeatedField('unknown', 'value'),
  ]) assert.throws(() => parseDecision(repeatedCalls(repeatedCall(fields + extra)), pwshRequest));
  const valid = repeatedCalls(repeatedCall(fields));
  assert.throws(() => parseDecision(valid, ChatRequest.parse({ ...pwshRequest, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(repeatedCalls(repeatedCall(repeatedField('command', 'Get-Date'))), pwshRequest), /description/);
});

test('outer JSON protects literal repeated DSML and balanced packed argument data remains unchanged', () => {
  const command = 'Write-Output "literal </｜｜DSML｜｜parameter> data"';
  const args = { command, description: 'Print literal marker' };
  const packed = repeatedCalls(repeatedCall(repeatedField('arguments', JSON.stringify(args))));
  assert.deepEqual(parseDecision(packed, pwshRequest), { kind: 'tool_call', name: 'pwsh', arguments: args });
  const content = repeatedCalls(repeatedCall(repeatedField('command', 'Get-Date')));
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'final', content }), request), { kind: 'final', content });
});

test('mixed repeated outer markers and standard inner tags preserve full string contents using schema', () => {
  const content = '    print("ready")\n\n' + 'x'.repeat(21000) + '\n';
  const source = '<｜｜DSML｜｜tool_calls｜｜DSML｜｜\n<｜｜DSML｜｜invoke name="write">\n' +
    '<｜｜DSML｜｜parameter name="file_path">file.py</｜｜DSML｜｜parameter>\n' +
    `<｜｜DSML｜｜parameter name="content">${content}</｜｜DSML｜｜parameter>\n` +
    '</｜｜DSML｜｜invoke>\n<｜｜DSML｜｜/tool_calls｜｜DSML｜｜>';
  assert.deepEqual(parseDecision(source, encodedRequest), { kind: 'tool_call', name: 'write',
    arguments: { file_path: 'file.py', content } });
  assert.throws(() => parseDecision(source.replace('name="content"', 'name="unknown"'), encodedRequest), /type/);
  assert.throws(() => parseDecision(source.replace('</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>', ''), encodedRequest), /incomplete/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...encodedRequest, tool_choice: 'none' })), /forbids/);
});
test('alternate DS markers retain exact edit indentation and become a tool decision', () => {
  const old = '        if ready:\n            return\n';
  const replacement = '        if ready:\n            return "verified"\n';
  const source = dsCalls(dsInvoke('edit', dsField('file_path', 'file.py') + dsField('old_string', old) + dsField('new_string', replacement)));
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, request, repair => repairs.push(repair)), { kind: 'tool_call', name: 'edit',
    arguments: { file_path: 'file.py', old_string: old, new_string: replacement } });
  assert.deepEqual(repairs, [{ kind: 'alternate_ds', tool: 'edit', parameter: 'call' }]);
});
test('alternate DS infers declared scalars and keeps marker text inside JSON argument data', () => {
  const args = { pattern: 'literal ｜｜DS｜｜/parameter｜｜DS｜｜ data' };
  const source = dsCalls(dsInvoke('read', dsField('file_path', 'file.py') + dsField('offset', '100') + dsField('limit', '120')) +
    dsInvoke('grep', dsField('arguments', JSON.stringify(args), ' string="false"')));
  assert.deepEqual(parseDecision(source, readRequest), { kind: 'tool_calls', calls: [
    { name: 'read', arguments: { file_path: 'file.py', offset: 100, limit: 120 } }, { name: 'grep', arguments: args },
  ] });
  assert.throws(() => parseDecision(dsCalls(dsInvoke('read', dsField('file_path', 'file.py') + dsField('offset', '"100"'))), readRequest), /schema/);
});
test('alternate DS never becomes a successful final for malformed or unknown tool markup', () => {
  for (const source of [
    'I will act. <｜｜DS｜｜invoke name="edit"｜｜DS｜｜',
    dsCalls(dsInvoke('unknown', dsField('file_path', 'file.py'))),
    dsCalls(dsInvoke('edit', dsField('file_path', 'file.py'))),
    dsCalls(dsInvoke('edit', dsField('file_path', 'file.py') + '<｜｜DS｜｜parameter name="old_string"｜｜DS｜｜>truncated')),
  ]) assert.throws(() => parseDecision(source, request));
  assert.throws(() => parseDecision(dsCalls(dsInvoke('grep', dsField('pattern', 'query'))),
    ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
});
test('SSE alternate DS emits native arguments and no raw final marker text', async () => {
  const source = dsCalls(dsInvoke('grep', dsField('pattern', 'verified')));
  const fake = (async (_config: unknown, _prompt: string, _path: unknown, emit?: (text: string) => void) => { emit?.(source);
    return { response: source, error: null, stage: 'inference' }; }) as unknown as typeof runProbe;
  const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
    { port: 0, key: 'test', infer: fake, reportDir: await mkdtemp(join(tmpdir(), 'qoderbridge-ds-')) });
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) });
    const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.ok(!events.some(event => event.choices?.[0]?.delta?.content));
    const calls = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].function.name, 'grep');
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { pattern: 'verified' });
    assert.ok(events.some(event => event.choices?.[0]?.finish_reason === 'tool_calls'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('a supplied tool discriminator wraps flat arguments without changing ranges or path', () => {
  const source = { kind: 'read', file_path: 'file.py', offset: 100, limit: 120 };
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(JSON.stringify(source), readRequest, repair => repairs.push(repair)), {
    kind: 'tool_call', name: 'read', arguments: { file_path: 'file.py', offset: 100, limit: 120 },
  });
  assert.deepEqual(repairs, [{ kind: 'flat_tool_kind', tool: 'read', parameter: 'kind' }]);
  const labelled = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: { name: 'label', parameters: {
    type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false,
  } } }] });
  assert.deepEqual(parseDecision('{"kind":"label","name":"actual parameter"}', labelled), {
    kind: 'tool_call', name: 'label', arguments: { name: 'actual parameter' },
  });
});
test('an explicit custom tool envelope preserves opaque argument strings and never becomes a false final', () => {
  const args={file_path:'file.py',old_string:'literal \\n and \\"quote\\"',new_string:'    actual\n'};
  const source='<custom_tool_call>\n'+JSON.stringify({name:'edit',arguments:args})+'\n</custom_tool_call>';
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(source,request,r=>repairs.push(r)),{kind:'tool_call',name:'edit',arguments:args});
  assert.deepEqual(repairs,[{kind:'custom_tool_envelope',tool:'edit',parameter:'call'}]);
  assert.deepEqual(parseDecision(JSON.stringify({kind:'final',content:source}),request),{kind:'final',content:source});
});
test('malformed custom envelopes reject incomplete, extra, unknown or forbidden calls rather than reporting success', () => {
  for(const body of ['{"name":"edit","arguments":{}}','{"name":"unknown","arguments":{}}',
    '{"name":"grep","arguments":{"pattern":"x"},"extra":true}','{"name":"grep","arguments":'])
    assert.throws(()=>parseDecision('<custom_tool_call>'+body+'</custom_tool_call>',request));
  assert.throws(()=>parseDecision('I will act. <custom_tool_call>{"name":"grep"}',request));
  assert.throws(()=>parseDecision('<custom_tool_call>{"name":"grep","arguments":{"pattern":"x"}}</custom_tool_call>',
    ChatRequest.parse({...request,tool_choice:'none'})),/forbids/);
});
test('an empty trailing field stub is removed only outside three complete edit strings', () => {
  const args={file_path:'file.py',old_string:'    before\n',new_string:'    after\n'};
  const full=JSON.stringify({kind:'tool_call',name:'edit',arguments:args});
  const malformed=full.slice(0,-2)+',"}}';const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(malformed,request,r=>repairs.push(r)),{kind:'tool_call',name:'edit',arguments:args});
  assert.deepEqual(repairs,[{kind:'terminal_field_stub',tool:'edit',parameter:'arguments'}]);
  const commaContent={file_path:'file.py',old_string:'before',new_string:'unfinished,'};
  assert.deepEqual(parseDecision(JSON.stringify({kind:'tool_call',name:'edit',arguments:commaContent}),request),
    {kind:'tool_call',name:'edit',arguments:commaContent});
  assert.throws(()=>parseDecision('{"kind":"tool_call","name":"edit","arguments":{"file_path":"file.py","old_string":"before","new_string":"unfinished',request));
  const extra=JSON.stringify({kind:'tool_call',name:'edit',arguments:{...args,unknown:'value'}});
  assert.throws(()=>parseDecision(extra.slice(0,-2)+',"}}',request));
  assert.throws(()=>parseDecision(malformed,ChatRequest.parse({...request,tool_choice:'none'})),/forbids/);
});
test('flat tool normalization retains schema, selected-tool and forbidden-tool checks', () => {
  for (const source of [
    { kind: 'unknown', file_path: 'file.py' }, { kind: 'read', offset: 100 },
    { kind: 'read', file_path: 'file.py', offset: '100' }, { kind: 'read', file_path: 'file.py', unknown: true },
  ]) assert.throws(() => parseDecision(JSON.stringify(source), readRequest));
  const source = '{"kind":"read","file_path":"file.py"}';
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...readRequest, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...readRequest,
    tool_choice: { type: 'function', function: { name: 'grep' } } })), /unselected/);
  const conflict = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: { name: 'label', parameters: {
    type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'], additionalProperties: false,
  } } }] });
  assert.throws(() => parseDecision('{"kind":"label"}', conflict), /discriminator/);
});
const dsmlField = (name: string, value: string, isString = true) =>
  `<｜｜DSML｜｜ parameter name="${name}" string="${isString}">${value}</｜｜DSML｜｜ parameter>`;
const literalField = (name: string, value: string) => `<｜｜DSML｜｜ parameter name="${name}">${value}</｜｜DSML｜｜ parameter>`;
test('an attributed edit header retains a complete old code block without inventing strings', () => {
  const old='    void before() {\n        log("quoted");\n    }';
  const body=`<｜｜DSML｜｜ file_path="file.java" old_string="${old}</｜｜DSML｜｜ parameter>`+literalField('new_string','    void after() {}');
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(wrap('edit',body),request,r=>repairs.push(r)),{kind:'tool_call',name:'edit',
    arguments:{file_path:'file.java',old_string:old,new_string:'    void after() {}'}});
  assert.deepEqual(repairs.map(r=>r.kind),['attribute_parameters']);
  assert.throws(()=>parseDecision(wrap('edit',body.replace(`${old}</`, 'truncated</')),request));
  assert.throws(()=>parseDecision(wrap('edit',body.replace('name="new_string"','name="unknown"')),request));
});
test('a decorated complete calls array tolerates only empty nameless protocol tail markers', () => {
  const calls=[{name:'grep',arguments:{pattern:'first'}},{name:'grep',arguments:{pattern:'second'}}];
  const head='<{**tool_calls**: '+JSON.stringify(calls);
  const tail='<｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ parameter>\n<</｜｜DSML｜｜ parameter>';
  assert.deepEqual(parseDecision(head+tail,request),{kind:'tool_calls',calls});
  for(const extra of ['text','{}','<｜｜DSML｜｜ invoke name="grep">','<｜｜DSML｜｜ parameter name="calls">'])
    assert.throws(()=>parseDecision(head+tail+extra,request));
  assert.throws(()=>parseDecision(head.slice(0,-1)+tail,request));
  assert.throws(()=>parseDecision(head+tail,ChatRequest.parse({...request,tool_choice:'none'})),/forbids/);
});
test('an empty tool_calls marker after a closed call is wrapper metadata while every operation remains', () => {
  const one = '<｜｜DSML｜｜ invoke name="grep">' + dsmlField('pattern','first') + '</｜｜DSML｜｜ invoke>';
  const two = '<｜｜DSML｜｜ invoke name="grep">' + dsmlField('pattern','second') + '</｜｜DSML｜｜ invoke>';
  const annotation = '<｜｜DSML｜｜ parameter name="tool_calls">\n';
  const source = '<｜｜DSML｜｜ calls>' + one + annotation + two + annotation + '</｜｜DSML｜｜ calls>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, request, repair=>repairs.push(repair)), {kind:'tool_calls',calls:[
    {name:'grep',arguments:{pattern:'first'}},{name:'grep',arguments:{pattern:'second'}},
  ]});
  assert.deepEqual(repairs.map(repair=>repair.kind),['empty_call_annotation','empty_call_annotation']);
});
test('nonempty call annotations or genuine declared inputs are never silently discarded', () => {
  const head = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="grep">' + dsmlField('pattern','first') + '</｜｜DSML｜｜ invoke>';
  const marker = '<｜｜DSML｜｜ parameter name="tool_calls">';
  for(const data of ['[]','unknown','[{"name":"grep","arguments":{"pattern":"second"}}]'])
    assert.throws(()=>parseDecision(head+marker+data,request));
  const declared = ChatRequest.parse({...request,tools:[{type:'function',function:{name:'grep',parameters:{type:'object',
    properties:{pattern:{type:'string'},tool_calls:{type:'string'}},required:['pattern']}}}]});
  assert.throws(()=>parseDecision(head+marker,declared));
  const pattern = '<｜｜DSML｜｜ parameter name="tool_calls">';
  assert.deepEqual(parseDecision(wrap('grep',dsmlField('arguments',JSON.stringify({pattern}),false)),request),
    {kind:'tool_call',name:'grep',arguments:{pattern}});
});
test('declared DSML string fields retain indentation without a redundant string attribute', () => {
  const args = { file_path: 'file.py', old_string: '    before\n', new_string: '    after\n' };
  assert.deepEqual(parseDecision(wrap('edit', Object.entries(args).map(([name,value]) => literalField(name,value)).join('')), request),
    { kind: 'tool_call', name: 'edit', arguments: args });
});
test('damaged file path boundary and misclosed untyped string field preserve separate exact arguments', () => {
  const body = '<｜｜DSML｜｜ parameter name="file_path">file.py｜｜DSML｜｜ parameter name="old_string">    before\n</｜｜DSML｜｜ parameter>' + literalField('new_string', '    after\n');
  assert.deepEqual(parseDecision(wrap('edit', body), request), { kind: 'tool_call', name: 'edit',
    arguments: { file_path: 'file.py', old_string: '    before\n', new_string: '    after\n' } });
  const misclosed = '<｜｜DSML｜｜ parameter name="file_path">file.py</｜｜DSML｜｜ parameter name="old_string">    before\n</｜｜DSML｜｜ parameter>' + literalField('new_string','    after\n');
  assert.deepEqual(parseDecision(wrap('edit', misclosed), request), { kind: 'tool_call', name: 'edit',
    arguments: { file_path: 'file.py', old_string: '    before\n', new_string: '    after\n' } });
});
test('closed trailing parameter call is recovered only by one fully declared supplied schema', () => {
  const first = { file_path: 'first.py', old_string: 'before', new_string: 'after' };
  const second = { file_path: 'second.py', old_string: '    old\n', new_string: '    new\n' };
  const fields = (args: typeof first) => Object.entries(args).map(([name,value]) => literalField(name,value)).join('');
  const prefix = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="edit">' + fields(first) + '</｜｜DSML｜｜ invoke>';
  const suffix = '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(prefix + fields(second) + suffix, request, repair => repairs.push(repair)),
    { kind: 'tool_calls', calls: [{ name: 'edit', arguments: first }, { name: 'edit', arguments: second }] });
  assert.deepEqual(repairs, [{ kind: 'schema_matched_call', tool: 'edit', parameter: 'call' }]);
  const clone = { ...request.tools![0]!, function: { ...request.tools![0]!.function, name: 'edit_clone' } };
  assert.throws(() => parseDecision(prefix + fields(second) + suffix, ChatRequest.parse({ ...request, tools: [...request.tools!, clone] })), /unique/);
  for (const incomplete of [literalField('file_path','second.py') + literalField('new_string','after'),
    fields(second) + literalField('unknown','value'), fields(second) + literalField('old_string','conflict')])
    assert.throws(() => parseDecision(prefix + incomplete + suffix, request));
  assert.throws(() => parseDecision(prefix + fields(second), request), /boundary/);
  assert.throws(() => parseDecision(prefix + fields(second) + suffix, ChatRequest.parse({ ...request, tool_choice:'none' })), /forbids/);
});
test('explicit field before DSML marker restores exact replacement and valid empty deletion', () => {
  const head = dsmlField('file_path', 'file.py') + dsmlField('old_string', '    before\n');
  for (const value of ['    after\n', '']) {
    const repairs: DecisionRepair[] = [];
    const source = wrap('edit', head + `<｜ new_string｜｜DSML｜｜>${value}</｜｜DSML｜｜ parameter>`);
    assert.deepEqual(parseDecision(source, request, repair => repairs.push(repair)), {
      kind: 'tool_call', name: 'edit', arguments: { file_path: 'file.py', old_string: '    before\n', new_string: value },
    });
    assert.deepEqual(repairs, [{ kind: 'prefix_shorthand_parameter', tool: 'edit', parameter: 'new_string' }]);
  }
});
test('prefix shorthand retains missing, unknown, conflicting and forbidden argument protection', () => {
  const head = dsmlField('file_path', 'file.py') + dsmlField('old_string', 'before');
  for (const field of ['<｜ unknown｜｜DSML｜｜>after</｜｜DSML｜｜ parameter>',
    '<｜ new_string｜｜DSML｜｜>truncated',
    dsmlField('new_string', 'canonical') + '<｜ new_string｜｜DSML｜｜>conflict</｜｜DSML｜｜ parameter>'])
    assert.throws(() => parseDecision(wrap('edit', head + field), request));
  const source = wrap('edit', head + '<｜ new_string｜｜DSML｜｜>after</｜｜DSML｜｜ parameter>');
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
});
const bareCall = (name: string, args: unknown) => dsmlField('name', name) + dsmlField('arguments', JSON.stringify(args), false);
test('mixed DSML forms keep named arguments separate from every explicit trailing call', () => {
  const content = 'def main():\n    print("ready")\n';
  const edits = { file_path: 'file.py', old_string: 'before', new_string: 'after' };
  const source = '<｜｜DSML｜｜ calls>' +
    '<｜｜DSML｜｜ invoke name="grep">' + dsmlField('pattern', 'ready') + '</｜｜DSML｜｜ invoke>' +
    '<｜｜DSML｜｜ invoke name="write">' + dsmlField('file_path', 'file.py') + dsmlField('content', content) +
    dsmlField('name', 'write') + '</｜｜DSML｜｜ invoke>' + bareCall('edit', edits) + '</｜｜DSML｜｜ calls>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, encodedRequest, repair => repairs.push(repair)), { kind: 'tool_calls', calls: [
    { name: 'grep', arguments: { pattern: 'ready' } },
    { name: 'write', arguments: { file_path: 'file.py', content } },
    { name: 'edit', arguments: edits },
  ] });
  assert.deepEqual(repairs.map(repair => repair.kind), ['redundant_tool_name', 'unwrapped_call']);
});
test('explicit unwrapped calls preserve repeated operations and protocol text inside JSON values', () => {
  const args = { pattern: 'literal </｜｜DSML｜｜ parameter> value' };
  const source = '<｜｜DSML｜｜ calls>' + bareCall('grep', args) + bareCall('grep', args) + '</｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(source, request), { kind: 'tool_calls', calls: [
    { name: 'grep', arguments: args }, { name: 'grep', arguments: args },
  ] });
});
test('trailing partial or invalid calls reject the whole batch without stealing named call fields', () => {
  const head = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="write">' +
    dsmlField('file_path', 'file.py') + dsmlField('content', 'valid') + '</｜｜DSML｜｜ invoke>';
  const suffix = '</｜｜DSML｜｜ calls>';
  for (const tail of [dsmlField('name', 'edit'), dsmlField('arguments', '{}', false), bareCall('edit', {}), bareCall('unknown', {})])
    assert.throws(() => parseDecision(head + tail + suffix, encodedRequest));
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision(head + bareCall('edit', {}) + suffix, encodedRequest, repair => repairs.push(repair)), /old_string|file_path/);
  assert.deepEqual(repairs, []);
});
test('invoke-like text in values and actual name parameters are preserved', () => {
  const pattern = 'literal </｜｜DSML｜｜ invoke> marker';
  assert.deepEqual(parseDecision(wrap('grep', dsmlField('pattern', pattern)), request), {
    kind: 'tool_call', name: 'grep', arguments: { pattern },
  });
  const custom = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: { name: 'label', parameters: {
    type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false,
  } } }] });
  assert.deepEqual(parseDecision(wrap('label', dsmlField('name', 'label')), custom), {
    kind: 'tool_call', name: 'label', arguments: { name: 'label' },
  });
});
test('outer JSON decisions keep embedded DSML as content rather than interpreting it as calls', () => {
  const content = '<｜｜DSML｜｜ calls>' + bareCall('grep', { pattern: 'example' }) + '</｜｜DSML｜｜ calls>';
  const source = JSON.stringify({ kind: 'tool_call', name: 'write', arguments: { file_path: 'example.txt', content } });
  assert.deepEqual(parseDecision(source, encodedRequest), { kind: 'tool_call', name: 'write', arguments: { file_path: 'example.txt', content } });
  assert.deepEqual(parseDecision('Explanation.\n' + source, encodedRequest), { kind: 'tool_call', name: 'write', arguments: { file_path: 'example.txt', content } });
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'final', content }), request), { kind: 'final', content });
});
test('malformed outer JSON cannot fall through to apparent DSML operations in its string data', () => {
  const embedded = '<｜｜DSML｜｜ calls>' + bareCall('grep', { pattern: 'example' }) + '</｜｜DSML｜｜ calls>';
  const invalid = '{"kind":"tool_call","name":"write","arguments":{"file_path":"example.txt","content":"' + embedded + '"}}';
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision(invalid, encodedRequest, repair => repairs.push(repair)));
  assert.deepEqual(repairs, []);
});
test('missing call-wrapper closes preserve every complete arguments object and invocation order', () => {
  const first = { file_path: 'file.py', old_string: 'import before', new_string: 'import after' };
  const second = { file_path: 'file.py', old_string: '__all__ = ["before"]\n', new_string: '__all__ = ["after"]\n' };
  const source = `{"kind":"tool_calls","calls":[{"name":"edit","arguments":${JSON.stringify(first)},` +
    `{"name":"edit","arguments":${JSON.stringify(second)}]}`;
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, request, repair => repairs.push(repair)), {
    kind: 'tool_calls', calls: [{ name: 'edit', arguments: first }, { name: 'edit', arguments: second }],
  });
  assert.deepEqual(repairs.map(repair => repair.kind), ['call_wrapper_close', 'call_wrapper_close']);
  const mixed = `{"kind":"tool_calls","calls":[{"name":"edit","arguments":${JSON.stringify(first)}},` +
    `{"name":"edit","arguments":${JSON.stringify(second)}]}`;
  assert.equal(parseDecision(mixed, request).kind, 'tool_calls');
  assert.equal(parseDecision('{"kind":"tool_calls","calls":[{"name":"grep","arguments":{"pattern":"query"}]}', request).kind, 'tool_calls');
});
test('the complete DSML calls parameter uses the same bounded missing-call-wrapper repair', () => {
  const first={name:'grep',arguments:{pattern:'first'}},second={name:'grep',arguments:{pattern:'second'}};
  const malformed=`[{"name":"grep","arguments":${JSON.stringify(first.arguments)},{"name":"grep","arguments":${JSON.stringify(second.arguments)}}]`;
  const source=wrap('tool_calls',dsmlField('calls',malformed,false));
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(source,request,r=>repairs.push(r)),{kind:'tool_calls',calls:[first,second]});
  assert.deepEqual(repairs,[{kind:'call_wrapper_close',tool:'grep',parameter:'call'}]);
  assert.throws(()=>parseDecision(wrap('tool_calls',dsmlField('calls','[{"name":"grep","arguments":{"pattern":"truncated',false)),request));
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...request,tool_choice:'none'})),/forbids/);
});

test('a missing call close with one duplicated decision tail preserves both complete commands', () => {
  const calls = [
    { name: 'pwsh', arguments: { command: 'Write-Output "literal ]} and quote"', description: 'first', workdir: 'D:\\fixture' } },
    { name: 'pwsh', arguments: { command: 'Get-Date\nGet-Location', description: 'second', workdir: 'D:\\fixture' } },
  ];
  const source = JSON.stringify({ kind: 'tool_calls', calls }).slice(0, -3) + ']}]}';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, pwshRequest, repair => repairs.push(repair)), { kind: 'tool_calls', calls });
  assert.deepEqual(repairs.map(repair => repair.kind), ['call_wrapper_close', 'redundant_decision_closers']);
});

test('duplicated tail recovery rejects extra data, incomplete arguments, invalid calls and forbidden tools', () => {
  const full = JSON.stringify({ kind: 'tool_calls', calls: [
    { name: 'pwsh', arguments: { command: 'Get-Date', description: 'first' } },
    { name: 'pwsh', arguments: { command: 'Get-Location', description: 'second' } },
  ] });
  const source = full.slice(0, -3) + ']}]}';
  for (const invalid of [source + ' more data', source + ']}', source.replace(']}]}', '],{}]}'),
    full.slice(0, -4) + ']}]}', source.replace('"description":"second"', '"unknown":"second"'),
    source.replace('"command":"Get-Location"', '"command":42'),
    source.replace('"Get-Location"', '"truncated')]) {
    const repairs: DecisionRepair[] = [];
    assert.throws(() => parseDecision(invalid, pwshRequest, repair => repairs.push(repair)));
    assert.deepEqual(repairs, []);
  }
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...pwshRequest, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(source.replace('"name":"pwsh"', '"name":"unknown"'), pwshRequest), /Unknown/);
});

test('missing final array and decision closes recover only complete call objects with unchanged arguments', () => {
  const first = { name: 'grep', arguments: { pattern: 'first' } };
  const second = { name: 'grep', arguments: { pattern: 'second' } };
  const full = JSON.stringify({ kind: 'tool_calls', calls: [first, second] });
  for (const missing of [full.slice(0, -2), full.slice(0, -1)]) {
    const repairs: DecisionRepair[] = [];
    assert.deepEqual(parseDecision(missing, request, repair => repairs.push(repair)), { kind: 'tool_calls', calls: [first, second] });
    assert.deepEqual(repairs, [{ kind: 'decision_wrapper_close', tool: 'grep', parameter: 'calls' }]);
  }
  assert.throws(() => parseDecision(full.slice(0, -3), request));
  assert.throws(() => parseDecision(full.slice(0, -5), request));
  assert.throws(() => parseDecision(full.slice(0, -2) + ',', request));
  assert.throws(() => parseDecision(full.slice(0, -2) + ' trailing', request));
});

test('decision tail repair still validates every call and respects forbidden tools', () => {
  const source = '{"kind":"tool_calls","calls":[{"name":"grep","arguments":{"pattern":"valid"}},{"name":"edit","arguments":{}}';
  assert.throws(() => parseDecision(source, request), /file_path|schema/);
  const valid = '{"kind":"tool_calls","calls":[{"name":"grep","arguments":{"pattern":"valid"}}';
  assert.throws(() => parseDecision(valid, ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
  assert.throws(() => parseDecision(valid.replace('"grep"', '"unknown"'), request), /Unknown/);
});
test('wrapper recovery rejects incomplete arguments, missing calls and extra properties or text', () => {
  const args = JSON.stringify({ pattern: 'query' });
  for (const source of [
    `{"kind":"tool_calls","calls":[{"name":"grep","arguments":${args},]}`,
    '{"kind":"tool_calls","calls":[{"name":"grep","arguments":{"pattern":"query"]}',
    `{"kind":"tool_calls","calls":[{"name":"grep","arguments":${args},"extra":true}]}`,
    `{"kind":"tool_calls","calls":[{"name":"grep","arguments":${args}] } unparsed data`,
    '{"kind":"tool_calls","calls":[{"name":"grep","arguments":{}, {"name":"grep","arguments":{"pattern":"ok"}]}',
  ]) {
    assert.throws(() => parseDecision(source, request));
  }
  const unknown = `{"kind":"tool_calls","calls":[{"name":"unknown","arguments":${args}]}`;
  assert.throws(() => parseDecision(unknown, request), /Unknown/);
});
test('single, parallel and narrated decisions decode string arguments exactly once', () => {
  const args = { pattern: '"quoted"|中文\\s+file', path: 'file.py' };
  const call = { name: 'grep', arguments: JSON.stringify(args) };
  const expected = { kind: 'tool_call', name: 'grep', arguments: args };
  assert.deepEqual(parseDecision(JSON.stringify({ kind: 'tool_call', ...call }), request), expected);
  for (const prefix of ['', 'Use this search.\n']) {
    const repairs: DecisionRepair[] = [];
    assert.deepEqual(parseDecision(prefix + JSON.stringify({ kind: 'tool_calls', calls: [call, call] }), request,
      repair => repairs.push(repair)), { kind: 'tool_calls', calls: [{ name: 'grep', arguments: args }, { name: 'grep', arguments: args }] });
    assert.deepEqual(repairs.map(repair => repair.kind), ['encoded_arguments', 'encoded_arguments']);
  }
});
test('known final write content with underescaped code quotes recovers exact contents', () => {
  const content = 'public final class Log {\n  String tag = "Demo";\n  String path = "C:\\logs";\n}\n';
  const argumentsString = JSON.stringify({ file_path: 'Log.java', content }).replace(/\\"/g, '"');
  const source = JSON.stringify({ kind: 'tool_call', name: 'write', arguments: argumentsString });
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, encodedRequest, repair => repairs.push(repair)), {
    kind: 'tool_call', name: 'write', arguments: { file_path: 'Log.java', content },
  });
  assert.deepEqual(repairs.map(repair => repair.kind), ['encoded_content_quotes', 'encoded_arguments']);
});

test('complete packed DSML write arguments recover bounded content quotes and one surplus wrapper close', () => {
  const content = '# build\nWrite-Output "verified"\n$path = "C:\\logs"\n';
  const raw = JSON.stringify({ file_path: 'build.ps1', content }).replace(/\\"/g, '"');
  for (const extra of ['', '}']) {
    const repairs: DecisionRepair[] = [];
    const source = wrap('write', dsmlField('arguments', raw + extra, false) + dsmlField('name', 'write'));
    assert.deepEqual(parseDecision(source, encodedRequest, repair => repairs.push(repair)), {
      kind: 'tool_call', name: 'write', arguments: { file_path: 'build.ps1', content },
    });
    assert.deepEqual(repairs.map(repair => repair.kind), ['packed_content_quotes', ...(extra ? ['arguments_wrapper_close'] : [])]);
  }
});

test('packed write quote repair rejects incomplete boundaries, extra fields and non-write arguments', () => {
  const ambiguous = '{"file_path":"build.ps1","content":"code "quote"", "extra":"value"}';
  assert.throws(() => parseDecision(wrap('write', dsmlField('arguments', ambiguous, false)), encodedRequest));
  const validShape = '{"file_path":"build.ps1","content":"code "quote""}';
  assert.throws(() => parseDecision(wrap('write', `<｜｜DSML｜｜ parameter name="arguments" string="false">${validShape}`), encodedRequest));
  assert.throws(() => parseDecision(wrap('grep', dsmlField('arguments', validShape, false)), encodedRequest));
});

test('upstream retries and capacity queue states remain diagnosable without storing server messages', () => {
  const t = new Telemetry();
  for (let attempt = 1; attempt <= 20; attempt++) t.observe({ type: 'system', subtype: 'api_retry', attempt,
    max_retries: 20, retry_delay_ms: 1000, error_status: 503, error: 'server_error', secret: 'private server detail' } as unknown as SDKMessage);
  t.observe({ type: 'system', subtype: 'model_queue_status', status: 'queued', queue_count: 4,
    queue_wait_elapsed_ms: 120000, queue_max_wait_ms: 300000, service_available: false } as unknown as SDKMessage);
  t.observe({ type: 'assistant', isApiErrorMessage: true, error: 'private unknown error',
    message: { content: [{ type: 'text', text: 'private response body' }] } } as unknown as SDKMessage);
  const report = t.snapshot();
  assert.equal(report.api_retries, 20);
  assert.equal(report.api_retry_details.length, 16);
  assert.equal(report.api_retry_details[0]!.attempt, 5);
  assert.equal(report.api_retry_details.at(-1)!.error_status, 503);
  assert.equal(report.model_queue_statuses[0]!.queue_wait_elapsed_ms, 120000);
  assert.deepEqual(report.api_error_categories, ['unknown']);
  assert.equal(report.credits, null);
  assert.ok(!JSON.stringify(report).includes('private'));
});
test('encoded arguments keep missing fields, extra fields, primitives and ambiguous contents invalid', () => {
  for (const value of ['[]', 'null', '42', '"{\\"pattern\\":\\"x\\"}"', '{}', '{"pattern":"x","extra":true}', '{"pattern":']) {
    assert.throws(() => parseDecision(JSON.stringify({ kind: 'tool_call', name: 'grep', arguments: value }), request));
  }
  const ambiguous = '{"file_path":"file.java","content":"code "quote"", "extra":"value"}';
  assert.throws(() => parseDecision(JSON.stringify({ kind: 'tool_call', name: 'write', arguments: ambiguous }), encodedRequest));
  assert.throws(() => parseDecision(JSON.stringify({ kind: 'tool_call', name: 'unknown', arguments: '{"pattern":"x"}' }), request), /Unknown/);
  const repairs: DecisionRepair[] = [];
  assert.throws(() => parseDecision(JSON.stringify({ kind: 'tool_calls', calls: [
    { name: 'grep', arguments: '{"pattern":"x"}' }, { name: 'grep', arguments: '{}' },
  ] }), request, repair => repairs.push(repair)), /pattern/);
  assert.deepEqual(repairs, []);
});
test('SSE delivers decoded parallel calls and withholds the entire batch if one call is invalid', async () => {
  const reportDir = await mkdtemp(join(tmpdir(), 'qoderbridge-encoded-'));
  for (const invalid of [false, true]) {
    const fake = (async () => ({ response: JSON.stringify({ kind: 'tool_calls', calls: [
      { name: 'grep', arguments: '{"pattern":"first"}' },
      { name: 'grep', arguments: invalid ? '{}' : '{"pattern":"second"}' },
    ] }), error: null, stage: 'inference' })) as unknown as typeof runProbe;
    const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
      { port: 0, key: 'test', infer: fake, reportDir });
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) });
      const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      const calls = events.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []);
      if (invalid) { assert.equal(calls.length, 0); assert.ok(events.some(event => event.error)); }
      else { assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments).pattern), ['first', 'second']);
        assert.ok(events.some(event => event.choices?.[0]?.finish_reason === 'tool_calls')); }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
test('the recorded attributed call wrapper accepts one complete explicit call and retains literal protocol data', () => {
  const args = { pattern: 'literal <｜｜DSML｜｜ invoke name="read">', path: 'D:\\project', include: '*.py' };
  const grep = ChatRequest.parse({ ...request, tools: [{ type: 'function', function: { name: 'grep', parameters: {
    type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } },
    required: ['pattern'], additionalProperties: false,
  } } }] });
  const source = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="tool_call_call" name="grep" arguments="' +
    JSON.stringify(args) + '</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, grep, r => repairs.push(r)), { kind: 'tool_call', name: 'grep', arguments: args });
  assert.deepEqual(repairs, [{ kind: 'attributed_call_envelope', tool: 'grep', parameter: 'call' }]);
  assert.throws(() => parseDecision(source.replace('name="grep" arguments=', 'name="unknown" arguments='), grep), /Unknown/);
  assert.throws(() => parseDecision(source.replace(JSON.stringify(args), '{"pattern":"cut'), grep));
  assert.throws(() => parseDecision(source.replace(JSON.stringify(args), '{}'), grep), /pattern/);
  assert.throws(() => parseDecision(source.replace('</｜｜DSML｜｜ parameter>', '</｜｜DSML｜｜ parameter> extra'), grep));
  assert.throws(() => parseDecision(source + source, grep));
  assert.throws(() => parseDecision(source, ChatRequest.parse({ ...grep, tool_choice: 'none' })), /forbids/);
});
test('a translated parameter opener restores only a complete declared string at a closed boundary', () => {
  const base = '<｜｜DSML｜｜ parameter name="file_path" string="true">file.py</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="old_string" string="true">before</｜｜DSML｜｜ parameter>\n';
  const value = '    # 停止线程\n    self._stop.set()\n';
  const localized = `<｜参数 name="new_string">${value}</｜｜DSML｜｜ parameter>`;
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(wrap('edit', base + localized), request, r => repairs.push(r)),
    { kind: 'tool_call', name: 'edit', arguments: { file_path: 'file.py', old_string: 'before', new_string: value } });
  assert.deepEqual(repairs, [{ kind: 'localized_parameter', tool: 'edit', parameter: 'new_string' }]);
  assert.deepEqual(parseDecision(wrap('edit', base + '<｜参数 name="new_string"></｜｜DSML｜｜ parameter>'), request),
    { kind: 'tool_call', name: 'edit', arguments: { file_path: 'file.py', old_string: 'before', new_string: '' } });
  assert.throws(() => parseDecision(wrap('edit', base + localized.replace('new_string', 'unknown')), request), /undeclared/);
  assert.throws(() => parseDecision(wrap('edit', base + '<｜参数 name="new_string">incomplete'), request));
  assert.throws(() => parseDecision(wrap('edit', base + localized + localized.replace(value, 'conflict')), request), /Duplicate/);
  assert.throws(() => parseDecision(wrap('edit', base + localized), ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
});
test('translated-looking text inside opaque canonical or JSON arguments stays data', () => {
  const literal = '<｜参数 name="new_string">literal';
  const body = '<｜｜DSML｜｜ parameter name="file_path" string="true">file.py</｜｜DSML｜｜ parameter>\n' +
    `<｜｜DSML｜｜ parameter name="old_string" string="true">${literal}</｜｜DSML｜｜ parameter>\n` +
    '<｜｜DSML｜｜ parameter name="new_string" string="true">after</｜｜DSML｜｜ parameter>';
  const expected = { kind: 'tool_call', name: 'edit', arguments: { file_path: 'file.py', old_string: literal, new_string: 'after' } };
  assert.deepEqual(parseDecision(wrap('edit', body), request), expected);
  const args = { pattern: '<｜参数 name="pattern">literal</｜｜DSML｜｜ parameter>' };
  assert.deepEqual(parseDecision(wrap('grep', `<｜｜DSML｜｜ parameter name="arguments" string="false">${JSON.stringify(args)}</｜｜DSML｜｜ parameter>`), request),
    { kind: 'tool_call', name: 'grep', arguments: args });
});
test('misclosed DSML edit field recovers exact old/new text and keeps it separate from the path', () => {
  const repairs: DecisionRepair[] = [];
  const decision = parseDecision(wrap('edit', editBody), request, repair => repairs.push(repair));
  assert.deepEqual(decision, { kind: 'tool_call', name: 'edit', arguments: {
    file_path: 'file.py', old_string: 'if closed:\n    break', new_string: 'if closed:\n    return',
  } });
  assert.deepEqual(repairs, [{ kind: 'misclosed_parameter', tool: 'edit', parameter: 'old_string' }]);
});
test('a generic name close carrying arguments attributes requires a complete object and preserves its strings', () => {
  const args = { pattern: 'literal </｜｜DSML｜｜ invoke> and "quote"' };
  const body = '<｜｜DSML｜｜ parameter name="name" string="true">grep</｜｜DSML｜｜ parameter name="arguments" string="false">' +
    JSON.stringify(args) + '</｜｜DSML｜｜ parameter>';
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(wrap('tool_call', body), request, r => repairs.push(r)),
    { kind: 'tool_call', name: 'grep', arguments: args });
  assert.deepEqual(repairs, [{ kind: 'generic_arguments_boundary', tool: 'grep', parameter: 'arguments' }]);
  assert.throws(() => parseDecision(wrap('tool_call', body.replace('>grep<', '>unknown<')), request), /Unknown/);
  assert.throws(() => parseDecision(wrap('tool_call', body.replace(JSON.stringify(args), '{"pattern":"cut')), request));
  assert.throws(() => parseDecision(wrap('tool_call', body.replace(JSON.stringify(args), '{}')), request), /pattern/);
  assert.throws(() => parseDecision(wrap('tool_call', body.replace(/<\/｜｜DSML｜｜ parameter>$/, '')), request));
  assert.throws(() => parseDecision(wrap('tool_call', body), ChatRequest.parse({ ...request, tool_choice: 'none' })), /forbids/);
});
test('self-closing empty annotations do not become duplicate or invented edit parameters', () => {
  const base = '<｜｜DSML｜｜ parameter name="file_path" string="true">file.py</｜｜DSML｜｜ parameter>\n';
  const old = '<｜｜DSML｜｜ parameter name="old_string" string="true">before</｜｜DSML｜｜ parameter>';
  const annotation = '<｜｜DSML｜｜ new_string" = ""/>\n</｜｜DSML｜｜ parameter>\n';
  const replacement = '<｜｜DSML｜｜ parameter name="new_string" string="true">after</｜｜DSML｜｜ parameter>\n';
  for (const placeholder of [annotation, annotation.replace('/>\n', '/>junk\n')]) {
    const repairs: DecisionRepair[] = [];
    assert.deepEqual(parseDecision(wrap('edit', base + placeholder + replacement + old), request, repair => repairs.push(repair)),
      { kind: 'tool_call', name: 'edit', arguments: { file_path: 'file.py', new_string: 'after', old_string: 'before' } });
    assert.deepEqual(repairs, [{ kind: 'parameter_annotation', tool: 'edit', parameter: 'new_string' }]);
  }
  assert.throws(() => parseDecision(wrap('edit', base + annotation + old), request), /new_string/);
  assert.throws(() => parseDecision(wrap('edit', base + annotation.replace('= ""', '= "conflict"') + replacement + old), request), /Ambiguous/);
  assert.throws(() => parseDecision(wrap('edit', base + annotation.replace('/>\n', '/>other-text\n') + replacement + old), request), /Ambiguous/);
  assert.throws(() => parseDecision(wrap('edit', base + replacement + replacement.replace('>after<', '>conflict<') + old), request), /Duplicate/);
  assert.equal(parseDecision(wrap('edit', base + replacement.replace('>after<', '><') + old), request).kind, 'tool_call');
});
test('attributed shorthand and identical repeated fields preserve one unchanged write; conflicts remain invalid', () => {
  const content = 'def main():\n    print("verified")\n';
  const body = `<｜｜DSML｜｜ parameter name="content" string="true">${content}</｜｜DSML｜｜ parameter>\n` +
    '<｜｜DSML｜｜ file_path" string="true">file.py</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ invoke>\n' +
    '<｜｜DSML｜｜ parameter name="file_path" string="true">file.py</｜｜DSML｜｜ parameter>\n' +
    `<｜｜DSML｜｜ parameter name="content" string="true">${content}</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ invoke>`;
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(wrap('write', body), encodedRequest, repair => repairs.push(repair)),
    { kind: 'tool_call', name: 'write', arguments: { content, file_path: 'file.py' } });
  assert.deepEqual(repairs.map(repair => repair.kind), ['attributed_shorthand_parameter', 'identical_parameter', 'identical_parameter']);
  assert.throws(() => parseDecision(wrap('write', body.replace('>file.py</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="content"',
    '>other.py</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="content"')), encodedRequest), /Duplicate DSML parameter: file_path/);
  assert.throws(() => parseDecision(wrap('write', body.replace('print("verified")\n</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ invoke>',
    'print("changed")\n</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ invoke>')), encodedRequest), /Duplicate DSML parameter: content/);
});
test('observed shorthand DSML grep field preserves regex characters without a new model request', () => {
  const repairs: DecisionRepair[] = [];
  const decision = parseDecision(wrap('grep', '<｜｜DSML｜｜ parameter name="path" string="true">file.py</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ pattern"def stop|def run_forever|_server</｜｜DSML｜｜ parameter>'), request, repair => repairs.push(repair));
  assert.deepEqual(decision, { kind: 'tool_call', name: 'grep', arguments: { path: 'file.py', pattern: 'def stop|def run_forever|_server' } });
  assert.deepEqual(repairs, [{ kind: 'shorthand_parameter', tool: 'grep', parameter: 'pattern' }]);
});
test('repairs reject missing, truncated, unknown and duplicate parameters instead of guessing edit values', () => {
  assert.throws(() => parseDecision(wrap('edit', editBody.replace(/<\/｜｜DSML｜｜ parameter name="old_string"[\s\S]*?<\/｜｜DSML｜｜ parameter>/, '</｜｜DSML｜｜ parameter>')), request), /old_string/);
  assert.throws(() => parseDecision(wrap('grep', '<｜｜DSML｜｜ pattern"unterminated'), request), /pattern/);
  assert.throws(() => parseDecision(wrap('grep', '<｜｜DSML｜｜ unknown"query</｜｜DSML｜｜ parameter>'), request), /pattern/);
  const repeated = '<｜｜DSML｜｜ parameter name="pattern" string="true">first</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ pattern"second</｜｜DSML｜｜ parameter>';
  assert.throws(() => parseDecision(wrap('grep', repeated), request), /Duplicate DSML parameter/);
});
test('literal DSML inside JSON argument strings remains unchanged', () => {
  const pattern = '<｜｜DSML｜｜ pattern"literal</｜｜DSML｜｜ parameter>';
  const source = wrap('grep', `<｜｜DSML｜｜ parameter name="arguments" string="false">${JSON.stringify({ pattern })}</｜｜DSML｜｜ parameter>`);
  const repairs: DecisionRepair[] = [];
  assert.deepEqual(parseDecision(source, request, repair => repairs.push(repair)),
    { kind: 'tool_call', name: 'grep', arguments: { pattern } });
  assert.deepEqual(repairs, []);
});
test('SDK stop reasons and assistant content types remain available when max_turns ends without text', () => {
  const t = new Telemetry();
  t.observe({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } } as unknown as SDKMessage);
  t.observe({ type: 'assistant', uuid: 'a', session_id: 's', message: { id: 'm', model: 'dfmodel', stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'private reasoning' }], usage: {} } } as unknown as SDKMessage);
  t.observe({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum number of turns (1)'],
    terminal_reason: 'max_turns', total_credits: 1.2, duration_ms: 10, duration_api_ms: 8, modelUsage: {}, usage: {} } as unknown as SDKMessage);
  const report = t.snapshot();
  assert.equal(t.text, '');
  assert.deepEqual(report.stream_stop_reasons, ['max_tokens']);
  assert.equal(report.requests[0]!.stop_reason, 'max_tokens');
  assert.deepEqual(report.requests[0]!.content_types, ['thinking']);
  assert.equal(report.total_session_credits, 1.2);
  assert.ok(!JSON.stringify(report).includes('private reasoning'));
});
test('Harness receives a useful schema/turn-limit error while invalid tools stay unexecuted', async () => {
  const reportDir = await mkdtemp(join(tmpdir(), 'qoderbridge-repair-'));
  for (const turnLimit of [false, true]) {
    const fake = (async () => ({ response: turnLimit ? '' : '{"kind":"tool_call","name":"grep","arguments":{}}',
      error: turnLimit ? 'Qoder result: error_max_turns' : null, stage: 'inference' })) as unknown as typeof runProbe;
    const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
      { port: 0, key: 'test', infer: fake, reportDir });
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify(request) });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error.code, turnLimit ? 'qoder_turn_limit' : 'tool_arguments_invalid');
      assert.match(body.error.message, turnLimit ? /per-request turn limit/ : /pattern/);
      assert.ok(body.error.request_id);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
