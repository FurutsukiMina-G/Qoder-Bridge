import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { createBridgeServer } from '../src/server.js';
import type { runProbe } from '../src/client.js';
const adapterPath = resolve('.runtime/dsh-new-shell/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js');
const { stream } = await import(pathToFileURL(adapterPath).href);
const checks = [];
for (const fail of [false, true]) {
  const fake = (async (_config, _prompt, _path, emit) => {
    emit?.('{"kind":"final","content":"OK');
    return { response: fail ? '{"kind":"final","content":"OK' : '{"kind":"final","content":"OK"}',
      error: null, stage: 'inference', normalized_usage: fail ? null : {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      } };
  }) as typeof runProbe;
  const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
    { port: 0, key: 'test', infer: fake });
  try {
    const port = (server.address() as AddressInfo).port;
    const model = { id: 'qoder-deepseek-flash', name: 'test', api: 'openai-completions', provider: 'qoderbridge',
      baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: true, input: ['text'],
      contextWindow: 1_000_000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true, supportsDeveloperRole: false } };
    const events: any[] = [];
    for await (const event of stream(model, { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] },
      { apiKey: 'test' })) events.push(event);
    const done = events.find(event => event.type === 'done');
    const error = events.find(event => event.type === 'error');
    if (fail ? !error || Boolean(done) : !done || Boolean(error)) throw new Error('Installed adapter terminal semantics failed');
    if (!fail && (done.message.usage.cacheRead !== 40 || done.message.usage.output !== 10))
      throw new Error('Installed adapter usage mapping failed');
    checks.push({ injectedError: fail, terminalEvent: fail ? error.type : done.type,
      eventTypes: events.map(event => event.type), usage: done?.message?.usage ?? null });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
await writeFile('reports/adapter-smoke.json', JSON.stringify({ adapterPath, checks }, null, 2));
console.log(JSON.stringify(checks, null, 2));
