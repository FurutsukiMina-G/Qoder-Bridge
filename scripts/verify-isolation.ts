import { readFile } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
const [sessionA, markerA, sessionB, markerB] = process.argv.slice(2);
if (![sessionA, markerA, sessionB, markerB].every(Boolean)) throw new Error('Usage: verify-isolation <sessionA> <markerA> <sessionB> <markerB>');
const described = await rpc('settings/describe');
const route = described.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai')?.value?.providers?.qoderbridge;
const context = route?.models?.find((m: { id: string }) => m.id === 'qoder-deepseek-flash')?.contextWindow;
const list = await rpc('session/list', { _request: {} });
const reports = (await readFile('reports/bridge.ndjson', 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
async function inspect(id: string, marker: string, other: string) {
  const item = list.items.find((row: { sessionId: string }) => row.sessionId === id);
  if (!item || item.running || !item.projections?.values?.turnOutline?.some((row: { response: string }) => row.response.includes(marker)))
    throw new Error(`Harness session ${id} did not finish with its own marker`);
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: id },
    throughSeq: item.projections.asOfSeq, maxMessages: 120 } });
  const events = page.records.map((r: { event: { type: string; data: unknown } }) => r.event);
  const tool = events.find((event: { type: string }) => event.type === 'tool/call');
  const toolResult = events.find((event: { type: string }) => event.type === 'tool/result');
  if (!tool || !toolResult || !JSON.stringify(toolResult.data).includes(marker) || JSON.stringify(toolResult.data).includes(other))
    throw new Error(`Harness native tool result crossed sessions for ${id}`);
  const final = [...reports].reverse().find(r => typeof r.response === 'string' && r.response.includes(marker));
  if (!final?.session_id || !final.client_session_key_present || !final.client_session_key_hash)
    throw new Error(`Qoder result for ${id} lacks session identity`);
  const turns = reports.filter(r => r.session_id === final.session_id && r.client_session_key_hash === final.client_session_key_hash);
  if (turns.length < 2 || !turns.some(r => r.reused_session) ||
      turns.some(r => !r.model_policy_calls?.some((p: { context_window: number; reasoning_effort: string }) =>
        p.context_window === 1_000_000 && p.reasoning_effort === 'max')))
    throw new Error(`Qoder model policy or within-session reuse failed for ${id}`);
  return { dsh_session: id, qoder_session: final.session_id, key_hash: final.client_session_key_hash,
    cwd: item.cwd, native_tool: tool.data.name, model_turns: turns.length, marker };
}
const a = await inspect(sessionA!, markerA!, markerB!);
const b = await inspect(sessionB!, markerB!, markerA!);
if (a.qoder_session === b.qoder_session || a.key_hash === b.key_hash || a.cwd === b.cwd)
  throw new Error('Two Harness sessions shared a Qoder session, client key, or workspace');
if (context !== 1_000_000) throw new Error(`Harness model context is ${context}, expected 1M`);
console.log(JSON.stringify({ ok: true, harness_context_window: context, sessions: [a, b] }, null, 2));
