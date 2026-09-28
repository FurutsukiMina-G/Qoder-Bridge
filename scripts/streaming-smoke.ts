import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const session = `stream-smoke-${randomUUID()}`;
const payload = { model: 'qoder-deepseek-flash', prompt_cache_key: session,
  messages: [{ role: 'user', content: 'Write exactly twelve numbered short sentences about maintaining a garden. No tools are needed. Return the required final JSON object with content as the last field.' }],
  stream: true, tool_choice: 'none', stream_options: { include_usage: true } };
async function run() {
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:8646/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let text = ''; let firstContentMs: number | null = null;
  let firstThinkingMs: number | null = null; let lastContentMs: number | null = null;
  let contentChunks = 0; let thinkingChunks = 0; let finish: string | null = null; let usage: unknown = null;
  let id: string | null = null;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (!block.startsWith('data: {')) continue;
      const event = JSON.parse(block.slice(6));
      if (event.error) throw new Error(`Streaming error: ${event.error.code ?? event.error.type}`);
      id ??= event.id; usage = event.usage ?? usage;
      const choice = event.choices?.[0]; const delta = choice?.delta;
      if (delta?.reasoning_content) { firstThinkingMs ??= performance.now() - start; thinkingChunks++; }
      if (delta?.content) {
        firstContentMs ??= performance.now() - start; lastContentMs = performance.now() - start;
        contentChunks++; text += delta.content;
      }
      finish = choice?.finish_reason ?? finish;
    }
  }
  if (finish !== 'stop' || !text.length || text.includes('"kind":"final"')) throw new Error('Final stream did not complete cleanly');
  return { id, contentChunks, thinkingChunks, firstContentMs, firstThinkingMs, lastContentMs,
    elapsedMs: performance.now() - start, chars: text.length, finish, usage, text };
}
const first = await run();
const replay = await run();
if (first.text !== replay.text) throw new Error('Identical retry changed the response');
const { text: _first, ...one } = first; const { text: _second, ...two } = replay;
const report = { checkedAt: new Date().toISOString(), session, first: one, replay: two };
await writeFile('reports/streaming-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
