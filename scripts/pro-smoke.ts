import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL } from '../src/model.js';
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const sessionKey = `cross-model-smoke-${randomUUID()}`;
async function call(model: string) {
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:8646/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(300000), body: JSON.stringify({ model, prompt_cache_key: sessionKey,
      messages: [{ role: 'user', content: 'Reply exactly MODEL_ROUTE_OK. No tools are needed.' }],
      stream: true, tool_choice: 'none', stream_options: { include_usage: true } }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let answer = ''; let id = ''; let finish: string | null = null;
  let firstTextMs: number | null = null; let firstThinkingMs: number | null = null;
  let chunks = 0; let usage: unknown = null;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (!block.startsWith('data: {')) continue;
      const event = JSON.parse(block.slice(6));
      if (event.error) throw new Error(`Bridge stream failed: ${event.error.code}`);
      if (event.model !== model) throw new Error('Stream relabeled the requested model');
      id ||= event.id; usage = event.usage ?? usage;
      const choice = event.choices?.[0];
      if (choice?.delta?.reasoning_content) firstThinkingMs ??= performance.now() - start;
      if (choice?.delta?.content) { firstTextMs ??= performance.now() - start; chunks++; answer += choice.delta.content; }
      finish = choice?.finish_reason ?? finish;
    }
  }
  if (finish !== 'stop' || answer.trim() !== 'MODEL_ROUTE_OK') throw new Error('Model did not return the expected final answer');
  return { model, id: id.replace(/^chatcmpl-/, ''), firstTextMs, firstThinkingMs, textChunks: chunks,
    elapsedMs: performance.now() - start, usage };
}
const calls = [];
for (const model of [DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL, DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL]) calls.push(await call(model));
await new Promise(resolve => setTimeout(resolve, 150));
const tasks = (await readFile('reports/tasks.ndjson', 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
const bridge = (await readFile('reports/bridge.ndjson', 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
const evidence = calls.map(call => {
  const task = tasks.find(row => row.bridge_request_id === call.id);
  const model = bridge.find(row => row.bridge_request_id === call.id);
  if (!task || task.status !== 'success' || !model) throw new Error('Missing successful model telemetry');
  return { ...call, qoderSession: task.qoder_session_id, qoderModel: model.model,
    actualResponseModels: (model.requests ?? []).map((row: { model: string }) => row.model),
    credits: task.telemetry.credits_delta, replay: task.telemetry.local_response_replay,
    policies: model.model_policy_calls, usageSource: model.normalized_usage_source,
    cacheStatus: model.client_cache_usage };
});
if (evidence[0]!.qoderModel !== 'dfmodel' || evidence[1]!.qoderModel !== 'dmodel' ||
  evidence[0]!.qoderSession === evidence[1]!.qoderSession) throw new Error('Models shared or misrouted a Qoder session');
for (const index of [2, 3]) if (!evidence[index]!.replay || evidence[index]!.credits !== 0 ||
  evidence[index]!.qoderSession !== evidence[index - 2]!.qoderSession) throw new Error('Per-model replay isolation failed');
const report = { checkedAt: new Date().toISOString(), sameHarnessSessionKey: true, evidence,
  credits: evidence.reduce((sum, row) => sum + (row.credits ?? 0), 0) };
await writeFile('reports/pro-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
