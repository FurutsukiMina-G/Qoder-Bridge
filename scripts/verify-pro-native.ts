import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rpc } from './dsh-rpc.js';

const [sessionId, marker] = process.argv.slice(2);
if (!sessionId?.startsWith('session-') || !marker?.startsWith('DSH_NATIVE_TOOL_OK_'))
  throw new Error('Pass the Pro native smoke session ID and marker');
const list = await rpc('session/list', { _request: {} });
const item = list.items.find((entry: any) => entry.sessionId === sessionId);
assert.ok(item && !item.running, 'Test session must be finished');
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId },
  throughSeq: item.projections.asOfSeq, maxMessages: 80 } });
const events = page.records.map((record: any) => record.event ?? record);
const calls = events.filter((event: any) => event.type === 'tool/call');
const readCall = calls.find((event: any) => event.data.name === 'read');
assert.ok(readCall, 'Harness must execute native read');
assert.ok(events.some((event: any) => event.type === 'tool/result' &&
  event.data.message?.toolCallId === readCall.data.callId && JSON.stringify(event.data).includes(marker)), 'Read result must contain marker');
assert.ok(events.some((event: any) => event.type === 'assistant/message' &&
  event.data.message?.content?.some((part: any) => part.type === 'text' && part.text.trim() === marker)), 'Final text must equal marker');
assert.ok(events.some((event: any) => event.type === 'turn/end' && event.data.reason?.kind === 'completed'));
const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
const readRows = async (path: string) => (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const tasks = (await readRows('reports/tasks.ndjson')).filter(row => row.harness_session_key_hash === hash);
const requests = new Set(tasks.map(row => row.bridge_request_id));
const turns = (await readRows('reports/bridge.ndjson')).filter(row => requests.has(row.bridge_request_id));
assert.equal(tasks.length, 2, 'Smoke should require exactly two model requests');
assert.equal(turns.length, tasks.length);
assert.ok(tasks.every(row => row.status === 'success' && typeof row.telemetry.credits_delta === 'number'));
assert.equal(new Set(turns.map(row => row.session_id)).size, 1, 'Tool continuation should reuse its Qoder session');
assert.ok(turns.every(row => row.model === 'dmodel' && row.requests?.length &&
  row.requests.every((request: any) => request.model === 'DeepSeek-V4-Pro') &&
  row.model_policy_calls?.length && row.model_policy_calls.every((policy: any) =>
    policy.model === 'dmodel' && policy.context_window === 1_000_000 && policy.reasoning_effort === 'max')));
const report = { checkedAt: new Date().toISOString(), sessionId, nativeTools: calls.map((event: any) => event.data.name),
  toolResultMarkerVerified: true, finalMarkerVerified: true, completed: true, modelErrors: 0,
  credits: tasks.reduce((sum, row) => sum + row.telemetry.credits_delta, 0),
  turns: turns.map(row => ({ bridgeRequestId: row.bridge_request_id, qoderSession: row.session_id,
    model: row.model, actualResponseModels: row.requests.map((request: any) => request.model),
    policies: row.model_policy_calls, credits: row.credits_delta, reused: row.reused_session,
    usage: row.client_usage, usageSource: row.normalized_usage_source, cacheStatus: row.client_cache_usage,
    sentToolDefinitionChars: row.sent_tool_definition_chars })),
  streaming: tasks.map(row => ({ firstTextMs: row.telemetry.first_client_text_ms ?? null,
    firstThinkingMs: row.telemetry.first_client_thinking_ms ?? null, chunks: row.telemetry.stream_chunks ?? null })),
};
await writeFile('reports/pro-native-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
