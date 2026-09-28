import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  telemetry: { credits_delta: number | null; wall_ms: number | null; api_ms: number | null; local_response_replay?: boolean;
    usage?: { prompt_tokens: number; completion_tokens: number } | null };
};
const events = (await readFile('reports/tasks.ndjson', 'utf8')).trim().split(/\r?\n/)
  .filter(Boolean).map(line => JSON.parse(line) as TaskEvent)
  .filter(event => event.bridge_port !== 0 && (!filterHash || event.harness_session_key_hash === filterHash));
const tokenTotal = (rows: TaskEvent[], field: 'prompt_tokens' | 'completion_tokens') => {
  const models = rows.filter(row => !row.telemetry.local_response_replay);
  return models.every(row => row.telemetry.usage) ? models.reduce((sum, row) => sum + row.telemetry.usage![field], 0) : null;
};
const groups = new Map<string, TaskEvent[]>();
for (const event of new Map(events.map(event => [event.bridge_request_id, event])).values()) {
  const key = event.harness_session_key_hash ?? `unkeyed:${event.qoder_session_id ?? event.bridge_request_id}`;
  groups.set(key, [...(groups.get(key) ?? []), event]);
}
const summaries = [...groups].map(([key, rows]) => {
  const credits = rows.map(row => row.telemetry.credits_delta);
  const prompt = rows.flatMap(row => row.input.user_messages)
    .find(row => !row.excerpt.startsWith('Current runtime context.'))?.excerpt ?? '';
  const names = rows.flatMap(row => row.output?.kind === 'tool_call' ? [row.output.name!] :
    row.output?.kind === 'tool_calls' ? (row.output.calls ?? []).map(call => call.name) : []);
  return { session_key_hash: key, requests: rows.length,
    model_requests: rows.filter(row => !row.telemetry.local_response_replay).length,
    local_replays: rows.filter(row => row.telemetry.local_response_replay).length,
    failed: rows.filter(row => row.status === 'error').length,
    tool_calls: names.length, tool_names: [...new Set(names)].join(', '),
    unique_tool_results: new Set(rows.flatMap(row => row.input.tool_results.map(result => result.tool_call_id)).filter(Boolean)).size,
    credits: credits.every(value => typeof value === 'number') ?
      Number((credits as number[]).reduce((sum, value) => sum + value, 0).toFixed(6)) : null,
    known_credits: Number(credits.reduce<number>((sum, value) => sum + (value ?? 0), 0).toFixed(6)),
    unknown_credit_requests: credits.filter(value => value === null).length,
    qoder_wall_ms: Math.round(rows.reduce((sum, row) => sum + (row.telemetry.wall_ms ?? 0), 0)),
    // Replays carry no usage; any unmeasured model request makes the session token total unknown.
    prompt_tokens: tokenTotal(rows, 'prompt_tokens'), completion_tokens: tokenTotal(rows, 'completion_tokens'),
    sent_prompt_chars: rows.reduce((sum, row) => sum + (row.input.prompt_chars_to_qoder ?? 0), 0),
    task: prompt.slice(0, 120),
    last_error: [...rows].reverse().find(row => row.error)?.error ?? '',
  };
});
console.table(summaries);
if (!summaries.length) process.exitCode = 1;
