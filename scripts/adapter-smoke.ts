import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createBridgeServer } from '../src/server.js';
import type { runProbe } from '../src/client.js';
const shellRoot = resolve(process.argv[2] ?? '.runtime/dsh-current-shell');
const packageRoot = resolve(shellRoot, 'dsh/node_modules/@earendil-works/pi-ai');
const adapterPath = resolve(packageRoot, 'dist/api/openai-completions.js');
const adapterVersion = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version;
await mkdir('.runtime', { recursive: true });
const reportDir = await mkdtemp(resolve('.runtime/adapter-fixtures-'));
const { stream } = await import(pathToFileURL(adapterPath).href);
const { normalizeContext } = await import(pathToFileURL(resolve(packageRoot, 'dist/utils/transcript.js')).href);
const checks = [];
for (const testCase of ['cached-final', 'uncached-final', 'tool-call', 'invalid-final']) {
  const fail = testCase === 'invalid-final';
  const tool = testCase === 'tool-call';
  const response = tool ? JSON.stringify({ kind: 'tool_call', name: 'read', arguments: { file_path: 'sentinel.txt' } })
    : '{"kind":"final","content":"OK"}';
  const fake = (async (_config, _prompt, _path, emit) => {
    if (!tool) emit?.('{"kind":"final","content":"OK');
    return { response: fail ? '{"kind":"final","content":"OK' : response,
      error: null, stage: 'inference', normalized_usage: fail ? null : {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        completion_tokens_details: { reasoning_tokens: 7 },
        ...(testCase === 'cached-final' ? { prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 } } : {}),
      } };
  }) as typeof runProbe;
  const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
    { port: 0, key: 'test', infer: fake, reportDir });
  try {
    const port = (server.address() as AddressInfo).port;
    const model = { id: 'qoder-deepseek-flash', name: 'test', api: 'openai-completions', provider: 'qoderbridge',
      baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: true, input: ['text'],
      contextWindow: 1_000_000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false } };
    const events: any[] = [];
    const tools = tool ? [{ name: 'read', description: 'Read a file', parameters: {
      type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false,
    } }] : undefined;
    for await (const event of stream(model, normalizeContext({ messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }], tools }),
      { apiKey: 'test' })) events.push(event);
    const done = events.find(event => event.type === 'done');
    const error = events.find(event => event.type === 'error');
    if (fail ? !error || Boolean(done) : !done || Boolean(error)) throw new Error('Installed adapter terminal semantics failed');
    if (!fail && (done.message.usage.cacheRead !== (testCase === 'cached-final' ? 40 : 0) ||
      done.message.usage.input !== (testCase === 'cached-final' ? 60 : 100) ||
      done.message.usage.output !== 10 || done.message.usage.reasoning !== 7 || done.message.usage.totalTokens !== 110))
      throw new Error('Installed adapter usage mapping failed');
    if (tool && !done.message.content.some((part: any) => part.type === 'toolCall' &&
      part.name === 'read' && part.arguments.file_path === 'sentinel.txt'))
      throw new Error('Installed adapter tool argument mapping failed');
    if (!fail && !tool && !done.message.content.some((part: any) => part.type === 'text' && part.text === 'OK'))
      throw new Error('Installed adapter streamed final text failed');
    checks.push({ testCase, injectedError: fail, terminalEvent: fail ? error.type : done.type,
      eventTypes: events.map(event => event.type), usage: done?.message?.usage ?? null });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
await writeFile('reports/adapter-smoke.json', JSON.stringify({ checkedAt: new Date().toISOString(),
  adapterPath, adapterVersion, checks }, null, 2));
console.log(JSON.stringify(checks, null, 2));
