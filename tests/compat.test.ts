import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer, PUBLIC_MODEL } from '../src/server.js';
import { ChatRequest, parseDecision, conversationPrompt } from '../src/compat.js';
import type { Config, runProbe } from '../src/client.js';

const config: Config = { auth: 'cli', timeout: 30000, strategy: 'permission', system: 'test' };
// Fixture requests must never append to the real reports/ logs.
const reportDir = await mkdtemp(join(tmpdir(), 'qoderbridge-test-'));
const task = { model: PUBLIC_MODEL, messages: [{ role: 'user', content: 'Read sentinel.txt' }],
  tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
  stream: true };
test('tool decisions honor selected name and JSON Schema; tool results remain in host conversation', () => {
  const req = ChatRequest.parse(task);
  assert.deepEqual(parseDecision('{"kind":"tool_call","name":"read_file","arguments":{"path":"sentinel.txt"}}', req),
    { kind: 'tool_call', name: 'read_file', arguments: { path: 'sentinel.txt' } });
  assert.throws(() => parseDecision('{"kind":"tool_call","name":"Bash","arguments":{}}', req));
  assert.throws(() => parseDecision('{"kind":"tool_call","name":"read_file","arguments":{"path":1}}', req));
  assert.throws(() => parseDecision('{"kind":"tool_call","name":"read_file","arguments":{}}', req),
    /required property/);
  const next = ChatRequest.parse({ ...task, messages: [...task.messages,
    { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"sentinel.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'SENTINEL_OK' }] });
  assert.match(conversationPrompt(next), /SENTINEL_OK/);
  assert.match(conversationPrompt(next), /call_1/);
});
test('compact prompt preserves tool names and required parameter keys while shrinking long descriptions', () => {
  const req = ChatRequest.parse({ ...task, tools: [{ type: 'function', function: {
    name: 'read_file', description: 'Read a file. ' + 'Extra usage notes. '.repeat(200),
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path. ' + 'More detail. '.repeat(100) } },
      required: ['path'] },
  } }] });
  const compact = conversationPrompt(req);
  const full = conversationPrompt(req, { fullToolDetails: true });
  assert.ok(compact.length < full.length / 2);
  assert.match(compact, /read_file/);
  assert.match(compact, /required\\?":\\?\[\\?"path/);
});
test('DSML tool decisions from Qoder become validated Harness tool calls', () => {
  const req = ChatRequest.parse({ ...task, tools: [{ type: 'function', function: {
    name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false },
  } }] });
  const wrapped = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n' +
    '<｜｜DSML｜｜ parameter name="arguments" string="false">{"path":"a{b}.txt","content":"quote: \\"x\\""}</｜｜DSML｜｜ parameter>';
  // Extra arguments must still fail the current Harness JSON Schema.
  assert.throws(() => parseDecision(wrapped, req));
  const valid = wrapped.replace(',"content":"quote: \\"x\\""', '');
  assert.deepEqual(parseDecision(valid, req), { kind: 'tool_call', name: 'read_file', arguments: { path: 'a{b}.txt' } });
  assert.deepEqual(parseDecision('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n' +
    '<｜｜DSML｜｜ parameter name="arguments": {"path":"file.txt"}}', req),
    { kind: 'tool_call', name: 'read_file', arguments: { path: 'file.txt' } });
  assert.throws(() => parseDecision('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="unknown">' +
    '<｜｜DSML｜｜ parameter name="arguments">{}', req));
});

test('unsupported fullwidth DSML tool envelopes cannot become final text or partial tool batches', () => {
  const req = ChatRequest.parse(task);
  const malformed = '<｟DSML｠｠ calls>\n<｟DSML｠｠ invoke name="read_file">\n' +
    '<｟DSML｠｠ parameter name="arguments" string="false">{"path":"sentinel.txt"}｟DSML｠｠ parameter>\n' +
    '</｟DSML｠｠ invoke>\n</｟DSML｠｠ calls>';
  const canonical = '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_file">' +
    '<｜｜DSML｜｜ parameter name="arguments">{"path":"first.txt"}</｜｜DSML｜｜ parameter>' +
    '</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  for (const source of [malformed, 'I will inspect the file.\n' + malformed, canonical + '\n' + malformed]) {
    const repairs: unknown[] = [];
    assert.throws(() => parseDecision(source, req, repair => repairs.push(repair)), /Malformed DSML tool envelope/);
    assert.deepEqual(repairs, []);
  }
});

test('unsupported marker examples remain literal data in final JSON and inline prose', () => {
  const req = ChatRequest.parse(task);
  const content = '<｟DSML｠｠ calls>\n<｟DSML｠｠ invoke name="read_file">';
  const value = { kind: 'final', content };
  for (const source of [JSON.stringify(value), JSON.stringify(value, null, 2),
    '```json\n' + JSON.stringify(value) + '\n```']) assert.deepEqual(parseDecision(source, req), value);
  const prose = 'The invalid marker <｟DSML｠｠ calls> must be reported as an error.';
  assert.deepEqual(parseDecision(prose, req), { kind: 'final', content: prose });
});

test('complete plain XML tool envelopes preserve explicit names and JSON arguments', () => {
  const req = ChatRequest.parse(task);
  const source = '<tool_call>\n<parameter name="name">read_file</parameter>\n' +
    '<parameter name="arguments">{"path":"a{b}.txt"}</parameter>\n</tool_call>';
  const repairs: unknown[] = [];
  assert.deepEqual(parseDecision(source, req, repair => repairs.push(repair)),
    { kind: 'tool_call', name: 'read_file', arguments: { path: 'a{b}.txt' } });
  assert.deepEqual(repairs, [{ kind: 'plain_tool_envelope', tool: 'read_file', parameter: 'call' }]);
});

test('plain XML envelopes reject incomplete, duplicate, invalid and additional calls atomically', () => {
  const req = ChatRequest.parse(task);
  const source = '<tool_call><parameter name="name">read_file</parameter>' +
    '<parameter name="arguments">{"path":"file.txt"}</parameter></tool_call>';
  for (const bad of [source.replace('</tool_call>', ''), source + source,
    source.replace('read_file', 'Bash'), source.replace('{"path":"file.txt"}', '{"path":1}'),
    source.replace('{"path":"file.txt"}', '{}'), source.replace('{"path":"file.txt"}', '{"path":'),
    source.replace('<parameter name="name">read_file</parameter>', ''),
    source.replace('<parameter name="arguments">', '<parameter name="name">read_file</parameter><parameter name="arguments">'),
    'Starting a tool call.\n' + source]) {
    const repairs: unknown[] = [];
    assert.throws(() => parseDecision(bad, req, repair => repairs.push(repair)));
    assert.deepEqual(repairs, []);
  }
});

test('plain XML markers in JSON string data and inline prose remain literal', () => {
  const req = ChatRequest.parse(task);
  const literal = '<tool_call>\n<parameter name="name">read_file</parameter>\n</tool_call>';
  const final = { kind: 'final', content: literal };
  assert.deepEqual(parseDecision(JSON.stringify(final), req), final);
  const call = { kind: 'tool_call', name: 'read_file', arguments: { path: literal } };
  assert.deepEqual(parseDecision(JSON.stringify(call), req), call);
  const prose = 'The marker <tool_call> is part of this sentence.';
  assert.deepEqual(parseDecision(prose, req), { kind: 'final', content: prose });
});
test('DSML direct scalar fields and generic tool_call wrapper keep native tool arguments', () => {
  const req = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'write fixture' }],
    tools: [{ type: 'function', function: { name: 'write', parameters: {
      type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'], additionalProperties: false,
    } } }] });
  const direct = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="write">\n' +
    '<｜｜DSML｜｜ parameter name="file_path" string="true">a.txt</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="content" string="true">line 1\nline 2</｜｜DSML｜｜ parameter>\n' +
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(direct, req), { kind: 'tool_call', name: 'write',
    arguments: { file_path: 'a.txt', content: 'line 1\nline 2' } });
  const generic = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="tool_call">\n' +
    '<｜｜DSML｜｜ parameter name="name" string="true">write</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="arguments" string="false">{"file_path":"b.txt","content":"ok"}' +
    '</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>';
  assert.deepEqual(parseDecision(generic, req), { kind: 'tool_call', name: 'write',
    arguments: { file_path: 'b.txt', content: 'ok' } });
});

test('multiple DSML calls retain separate arguments and validate every call', () => {
  const req = ChatRequest.parse(task);
  const invoke = (name: string, path: string) => `<｜｜DSML｜｜ invoke name="${name}">\n` +
    `<｜｜DSML｜｜ parameter name="arguments" string="false">{"path":"${path}"}</｜｜DSML｜｜ parameter>\n` +
    '</｜｜DSML｜｜ invoke>\n';
  const source = '<｜｜DSML｜｜ calls>\n' + invoke('read_file', 'a.txt') +
    invoke('read_file', 'b.txt') + '</｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(source, req), { kind: 'tool_calls', calls: [
    { name: 'read_file', arguments: { path: 'a.txt' } },
    { name: 'read_file', arguments: { path: 'b.txt' } },
  ] });
  assert.throws(() => parseDecision(source.replace('"b.txt"', '12'), req), /violate/);
  assert.throws(() => parseDecision(source.replace('invoke name="read_file">\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"path":"b.txt"}',
    'invoke name="missing">\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"path":"b.txt"}'), req), /Unknown/);
});

test('Qoder DSML calls parameter and preceding narration become validated tool calls', () => {
  const req = ChatRequest.parse(task);
  const calls = [
    { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
    { name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
  ];
  const wrapped = (items: unknown[]) => 'I will inspect both files.\n<｜｜DSML｜｜ calls>\n' +
    `<｜｜DSML｜｜ parameter name="calls" string="false">${JSON.stringify(items)}</｜｜DSML｜｜ parameter>\n` +
    '</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(wrapped(calls), req), { kind: 'tool_calls', calls: [
    { name: 'read_file', arguments: { path: 'a.txt' } },
    { name: 'read_file', arguments: { path: 'b.txt' } },
  ] });
  assert.throws(() => parseDecision(wrapped([{ name: 'read_file', arguments: '{"path":42}' }]), req), /violate/);
  assert.throws(() => parseDecision(wrapped([{ name: 'unknown', arguments: '{}' }]), req), /Unknown/);
  const extraCloser = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ parameter name="calls" string="false">' +
    JSON.stringify([calls[0]]) + '}</｜｜DSML｜｜ parameter>';
  assert.deepEqual(parseDecision(extraCloser, req), { kind: 'tool_call', name: 'read_file',
    arguments: { path: 'a.txt' } });
  assert.throws(() => parseDecision(extraCloser.replace('}</｜｜DSML', '} and run an unknown tool</｜｜DSML'), req));
  assert.throws(() => parseDecision(wrapped([{ arguments: '{}' }]), req), /Decision shape invalid: name:/);
});

test('alternate DSML tool_calls marker and inline array preserve native tools', () => {
  const req = ChatRequest.parse(task);
  assert.deepEqual(parseDecision('<｜｜DSML｜｜ tool_calls>\n<｜｜DSML｜｜ invoke name="read_file">' +
    '<｜｜DSML｜｜ parameter name="arguments">{"path":"a.txt"}</｜｜DSML｜｜ parameter>', req),
  { kind: 'tool_call', name: 'read_file', arguments: { path: 'a.txt' } });
  const inline = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="tool_calls" string="false">' +
    '[{"name":"read_file","arguments":"{\\"path\\":\\"b.txt\\"}"}]</｜｜DSML｜｜ invoke>';
  assert.deepEqual(parseDecision(inline, req), { kind: 'tool_call', name: 'read_file',
    arguments: { path: 'b.txt' } });
});

test('recovers a no-invoke DSML call only when explicit arguments and tool name are present', () => {
  const req = ChatRequest.parse(task);
  const malformed = '<｜｜DSML｜｜ calls>\n' +
    '<｜｜DSML｜｜ parameter name="arguments" string="false">{"path":"a.txt"}</｜｜DSML｜｜ parameter>\n' +
    '<｜｜DSML｜｜ parameter name="name":"read_file"}\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ calls>';
  assert.deepEqual(parseDecision(malformed, req), { kind: 'tool_call', name: 'read_file',
    arguments: { path: 'a.txt' } });
  assert.throws(() => parseDecision(malformed.replace('name":"read_file"', 'name":"missing"'), req), /Unknown/);
  assert.throws(() => parseDecision(malformed.replace('{"path":"a.txt"}', '{"path":12}'), req), /violate/);
  assert.throws(() => parseDecision(malformed.replace('name":"read_file"', 'name"'), req), /no tool calls/);
});

test('repairs raw control characters and two observed tool-call wrappers without bypassing schemas', () => {
  const req = ChatRequest.parse({ model: PUBLIC_MODEL, messages: [{ role: 'user', content: 'write' }],
    tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'], additionalProperties: false } } }],
  });
  assert.deepEqual(parseDecision('{"kind":"tool_call","name":"write","arguments":' +
    '{"file_path":"a.txt","content":"first\nsecond"}}', req),
  { kind: 'tool_call', name: 'write', arguments: { file_path: 'a.txt', content: 'first\nsecond' } });
  assert.deepEqual(parseDecision('{"kind":"tool_calls":[{"name":"write","arguments":' +
    '{"file_path":"a.txt","content":"ok"}}]}', req),
  { kind: 'tool_calls', calls: [{ name: 'write', arguments: { file_path: 'a.txt', content: 'ok' } }] });
  assert.deepEqual(parseDecision('{"kind":"tool_call":{"name":"write","arguments":' +
    '{"file_path":"a.txt","content":"ok"}}}', req),
  { kind: 'tool_call', name: 'write', arguments: { file_path: 'a.txt', content: 'ok' } });
  assert.throws(() => parseDecision('{"kind":"tool_calls":[{"name":"write","arguments":' +
    '{"file_path":"a.txt"}}]}', req), /violate/);
});

test('HTTP SSE emits every parallel native tool call', async () => {
  const fake = (async () => ({ response: JSON.stringify({ kind: 'tool_calls', calls: [
    { name: 'read_file', arguments: { path: 'a.txt' } },
    { name: 'read_file', arguments: { path: 'b.txt' } },
  ] }), error: null, stage: 'inference' })) as unknown as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test-key', infer: fake, reportDir });
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify(task) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)));
    const calls = events.flatMap(event => event.choices[0].delta.tool_calls ?? []);
    assert.deepEqual(calls.map(call => call.index), [0, 1]);
    assert.deepEqual(calls.map(call => JSON.parse(call.function.arguments).path), ['a.txt', 'b.txt']);
    assert.notEqual(calls[0].id, calls[1].id);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('explanatory prose before a complete JSON decision does not waste a model turn', () => {
  const req = ChatRequest.parse(task);
  const prose = 'The tool should read the file.\n\n' +
    '{"kind":"tool_call","name":"read_file","arguments":{"path":"sentinel.txt"}}';
  assert.deepEqual(parseDecision(prose, req), { kind: 'tool_call', name: 'read_file',
    arguments: { path: 'sentinel.txt' } });
  assert.deepEqual(parseDecision('Explanation only, no structured decision.', req),
    { kind: 'final', content: 'Explanation only, no structured decision.' });
  assert.throws(() => parseDecision('{"kind":"tool_call","name":"read_file","arguments":', req));
});
test('HTTP SSE emits a standard tool_calls finish and protects the local endpoint', async () => {
  const fake = (async () => ({ response: '{"kind":"tool_call","name":"read_file","arguments":{"path":"sentinel.txt"}}',
    error: null, stage: 'inference' })) as unknown as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test-key', infer: fake, reportDir });
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${base}/v1/models`);
    assert.equal(denied.status, 401);
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer test-key' } });
    assert.equal((await models.json()).data[0].id, PUBLIC_MODEL);
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify(task) });
    assert.equal(response.status, 200);
    const output = await response.text();
    assert.match(output, /"finish_reason":"tool_calls"/);
    assert.match(output, /"name":"read_file"/);
    const events = output.split('\n\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)));
    const call = events.flatMap(event => event.choices[0].delta.tool_calls ?? [])[0];
    assert.deepEqual(JSON.parse(call.function.arguments), { path: 'sentinel.txt' });
    assert.match(output, /data: \[DONE\]/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
