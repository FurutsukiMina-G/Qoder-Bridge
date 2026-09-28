import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FinalTextProjector } from '../src/streaming.js';
import { createBridgeServer, PUBLIC_MODEL } from '../src/server.js';
import type { Config, runProbe } from '../src/client.js';
import { reportedUsage } from '../src/usage.js';

const config: Config = { auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' };
// Fixture requests must never append to the real reports/ logs.
const reportDir = await mkdtemp(join(tmpdir(), 'qoderbridge-test-'));
const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify(body),
});
test('final JSON string streams across split escapes and surrogate pairs without protocol text', () => {
  let output = '';
  const projector = new FinalTextProjector(text => { output += text; });
  const raw = '{"kind":"final","content":"Hello \\uD83D\\uDE00\\n中文 \\"quote\\""}';
  for (const char of raw) projector.push(char);
  const expected = 'Hello 😀\n中文 "quote"';
  assert.equal(output, expected);
  projector.finish({ kind: 'final', content: expected });
  assert.equal(output, expected);
  assert.throws(() => projector.validate({ kind: 'tool_call', name: 'read', arguments: {} }));
});
test('DSML and tool JSON are withheld, plain final text can still complete', () => {
  let output = '';
  const p = new FinalTextProjector(text => { output += text; });
  p.push('<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read">');
  assert.equal(output, '');
  p.finish({ kind: 'tool_call', name: 'read', arguments: {} });
  assert.equal(output, '');
  const q = new FinalTextProjector(text => { output += text; });
  q.push('A plain final answer.');
  assert.equal(output, '');
  q.finish({ kind: 'final', content: 'A plain final answer.' });
  assert.equal(output, 'A plain final answer.');
});
test('HTTP delivers visible answer before inference finishes and reports real usage once', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fake = (async (_config, _prompt, _path, onText) => {
    onText?.('{"kind":"final","content":"first');
    await gate;
    onText?.(' second"}');
    return { response: '{"kind":"final","content":"first second"}', error: null, stage: 'inference',
      normalized_usage: reportedUsage({ input_tokens: 100, output_tokens: 10,
        cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }) };
  }) as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test', infer: fake, reportDir });
  try {
    const response = await post((server.address() as AddressInfo).port, { model: PUBLIC_MODEL,
      messages: [{ role: 'user', content: 'test' }], stream: true, stream_options: { include_usage: true } });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    while (!text.includes('"content":"first"')) {
      const part = await reader.read(); assert.equal(part.done, false); text += decoder.decode(part.value);
    }
    assert.ok(!text.includes('"finish_reason":"stop"'));
    release();
    while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
    const events = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join(''), 'first second');
    assert.equal(events.filter(e => e.usage).length, 1);
    assert.equal(events.find(e => e.usage).usage.prompt_tokens, 150);
    assert.match(text, /\[DONE\]/);
  } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('invalid streamed decisions end as an error without tool arguments or a successful finish', async () => {
  const fake = (async (_config, _prompt, _path, onText) => {
    onText?.('{"kind":"tool_call","name":"danger","arguments":');
    return { response: '{"kind":"tool_call","name":"danger","arguments":', error: null, stage: 'inference' };
  }) as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test', infer: fake, reportDir });
  try {
    const response = await post((server.address() as AddressInfo).port, { model: PUBLIC_MODEL,
      messages: [{ role: 'user', content: 'test' }], stream: true });
    const raw = await response.text();
    assert.match(raw, /"error":/); assert.doesNotMatch(raw, /"tool_calls":|"finish_reason":"stop"|\[DONE\]/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('unsupported images fail as a client error before opening the stream or invoking a model', async () => {
  let calls = 0;
  const fake = (async () => { calls++; throw new Error('must not run'); }) as unknown as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test', infer: fake, reportDir });
  try {
    const response = await post((server.address() as AddressInfo).port, { model: PUBLIC_MODEL, stream: true,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] });
    assert.equal(response.status, 400); assert.equal(calls, 0);
    assert.match(response.headers.get('content-type')!, /application\/json/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('the pool client usage is what the Harness receives, and fixture logs stay out of reports/', async () => {
  const before = await stat('reports/tasks.ndjson').then(file => file.size, () => 0);
  const sent = { prompt_tokens: 9230, completion_tokens: 4, total_tokens: 9234,
    prompt_tokens_details: { cached_tokens: 9216 }, completion_tokens_details: { reasoning_tokens: 1 } };
  const fake = (async () => ({ response: '{"kind":"final","content":"OK"}', error: null, stage: 'inference',
    normalized_usage: { prompt_tokens: 9230, completion_tokens: 4, total_tokens: 9234 }, client_usage: sent })) as unknown as typeof runProbe;
  const server = await createBridgeServer(config, { port: 0, key: 'test', infer: fake, reportDir });
  try {
    const response = await post((server.address() as AddressInfo).port, { model: PUBLIC_MODEL,
      messages: [{ role: 'user', content: 'test' }] });
    assert.deepEqual((await response.json()).usage, sent);
    assert.equal(await stat('reports/tasks.ndjson').then(file => file.size, () => 0), before);
    assert.ok((await readFile(join(reportDir, 'tasks.ndjson'), 'utf8')).includes('"client_usage"'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
