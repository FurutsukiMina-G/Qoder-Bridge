import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {requestAccounting,requestTokenAccounting,type RequestAccounting} from '../src/request-metrics.js';
const args = process.argv.slice(2);
const filterId = args[args.indexOf('--session') + 1] && args.includes('--session')
  ? args[args.indexOf('--session') + 1] : undefined;
const filterHash = filterId ? createHash('sha256').update(filterId).digest('hex').slice(0, 12) : undefined;
type TaskEvent = {
  time: string; harness_session_key_hash: string | null; qoder_session_id: string | null;
  bridge_port?: number;
  bridge_request_id: string; status: string; error: string | null;
  input: { user_messages: Array<{ excerpt: string; chars: number }>;
    tool_results: Array<{ tool_call_id?: string }>; prompt_chars_to_qoder: number | null };
  output: { kind: string; name?: string; calls?: Array<{ name: string }>; content?: { excerpt: string } } | null;
  telemetry: NonNullable<RequestAccounting['telemetry']> & {wall_ms:number|null;api_ms:number|null};
};
const events = (await readFile('reports/tasks.ndjson', 'utf8')).trim().split(/\r?\n/)
  .filter(Boolean).map(line => JSON.parse(line) as TaskEvent)
  .filter(event => event.bridge_port !== 0 && (!filterHash || event.harness_session_key_hash === filterHash));
const groups = new Map<string, TaskEvent[]>();
for (const event of new Map(events.map(event => [event.bridge_request_id, event])).values()) {
  const key = event.harness_session_key_hash ?? `unkeyed:${event.qoder_session_id ?? event.bridge_request_id}`;
  groups.set(key, [...(groups.get(key) ?? []), event]);
}
const summaries = [...groups].map(([key, rows]) => {
  const accounting=requestAccounting(rows),tokens=requestTokenAccounting(rows);
  const prompt = rows.flatMap(row => row.input.user_messages)
    .find(row => !row.excerpt.startsWith('Current runtime context.'))?.excerpt ?? '';
  const names = rows.flatMap(row => row.output?.kind === 'tool_call' ? [row.output.name!] :
    row.output?.kind === 'tool_calls' ? (row.output.calls ?? []).map(call => call.name) : []);
  return { session_key_hash: key, requests: rows.length,
    model_requests: accounting.upstreamModelRequestCountUnknown?null:accounting.upstreamModelRequestsKnown,
    known_model_requests:accounting.upstreamModelRequestsKnown,
    unknown_model_request_counts:accounting.upstreamModelRequestCountUnknown,
    local_replays: rows.filter(row => row.telemetry.local_response_replay).length,
    failed: rows.filter(row => row.status === 'error').length,
    tool_calls: names.length, tool_names: [...new Set(names)].join(', '),
    unique_tool_results: new Set(rows.flatMap(row => row.input.tool_results.map(result => result.tool_call_id)).filter(Boolean)).size,
    credits:accounting.unknownCreditRequests?null:Number(accounting.knownCredits.toFixed(6)),
    known_credits:Number(accounting.knownCredits.toFixed(6)),
    unknown_credit_requests:accounting.unknownCreditRequests,
    qoder_wall_ms: Math.round(rows.reduce((sum, row) => sum + (row.telemetry.wall_ms ?? 0), 0)),
    // Replays carry no usage; any unmeasured model request makes the session token total unknown.
    prompt_tokens:tokens.promptTokens,completion_tokens:tokens.completionTokens,
    known_prompt_tokens:tokens.knownPromptTokens,known_completion_tokens:tokens.knownCompletionTokens,
    sent_prompt_chars: rows.reduce((sum, row) => sum + (row.input.prompt_chars_to_qoder ?? 0), 0),
    task: prompt.slice(0, 120),
    last_error: [...rows].reverse().find(row => row.error)?.error ?? '',
  };
});
console.table(summaries);
if (!summaries.length) process.exitCode = 1;
