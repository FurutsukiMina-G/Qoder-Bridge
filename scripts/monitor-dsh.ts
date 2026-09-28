import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';

type TaskEvent = {
  time: string; harness_session_key_hash: string | null; status: string; error: string | null;
  output?: { kind?: string; name?: string; calls?: Array<{ name: string }> } | null;
  telemetry?: { credits_delta?: number | null; wall_ms?: number | null; local_response_replay?: boolean };
};
const described = await rpc('settings/describe');
const baseURL = described.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai')
  ?.value?.providers?.qoderbridge?.baseURL as string | undefined;
const bridgeOrigin = baseURL ? new URL(baseURL).origin : 'http://127.0.0.1:8646';
const bridgePort = Number(new URL(bridgeOrigin).port);
const service = await fetch(`${bridgeOrigin}/health`).then(r => r.ok ? r.json() : null).catch(() => null);
const list = await rpc('session/list', { _request: {} });
const events: TaskEvent[] = (await readFile('reports/tasks.ndjson', 'utf8')).trim().split(/\r?\n/).filter(Boolean)
  .map(line => JSON.parse(line) as TaskEvent);
const args = process.argv.slice(2);
const requestedSession = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
const family = new Set<string>(requestedSession ? [requestedSession] : []);
if (requestedSession) {
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of list.items as Array<{ sessionId: string; parentSessionId?: string }>) {
      if (item.parentSessionId && family.has(item.parentSessionId) && !family.has(item.sessionId)) {
        family.add(item.sessionId);
        expanded = true;
      }
    }
  }
}
const relevant = requestedSession
  ? list.items.filter((item: { sessionId: string }) => family.has(item.sessionId))
  : list.items.filter((item: { running: boolean }) => item.running);
const records: Array<{ sessionId: string; eventSeq: number | null; running: boolean;
  errorCount: number; [key: string]: unknown }> = relevant.map((item: {
  sessionId: string; parentSessionId?: string; running: boolean; cwd?: string;
  projections?: { asOfSeq?: number; values?: Record<string, any> };
}) => {
  const key = createHash('sha256').update(item.sessionId).digest('hex').slice(0, 12);
  const turns = events.filter(event => event.harness_session_key_hash === key);
  const last = turns.at(-1);
  const values = item.projections?.values ?? {};
  const credits = turns.map(turn => turn.telemetry?.credits_delta);
  const errors = turns.filter(turn => turn.error);
  return {
    sessionId: item.sessionId, parentSessionId: item.parentSessionId ?? null,
    keyHash: key, cwd: item.cwd ?? null,
    title: values.title ?? null, running: item.running, eventSeq: item.projections?.asOfSeq ?? null,
    turns: values.sessionStats?.turns ?? null, steps: values.sessionStats?.steps ?? null,
    lastPromptAt: values.sessionListMetadata?.lastPromptAt ?? null,
    modelRequests: turns.filter(turn => !turn.telemetry?.local_response_replay).length,
    localReplays: turns.filter(turn => turn.telemetry?.local_response_replay).length,
    credits: credits.every(x => typeof x === 'number') ? credits.reduce((sum, x) => sum + (x ?? 0), 0) : null,
    lastModelAt: last?.time ?? null, lastModelStatus: last?.status ?? null,
    lastToolDecision: last?.output?.kind === 'tool_call' ? last.output.name ?? null :
      last?.output?.kind === 'tool_calls' ? last.output.calls?.map(call => call.name).join(', ') ?? null : null,
    errorCount: errors.length, lastErrorAt: errors.at(-1)?.time ?? null,
    lastModelError: errors.at(-1)?.error ?? null,
    planActive: values.plan?.active ?? false,
    todoCount: Array.isArray(values.todos) ? values.todos.length : null,
  };
});
const checkedAt = new Date().toISOString();
const bridgeHealthy = service?.status === 'ok';
let changes: string[] = [];
let alerts: string[] = [];
let complete = false;
if (requestedSession) {
  const targetHash = createHash('sha256').update(requestedSession).digest('hex').slice(0, 12);
  const statePath = `.runtime/monitor-state-${targetHash}.json`;
  type PreviousState = { bridgeHealthy: boolean; bridgePort?: number; lastProgressAt: string;
    sessions: Array<{ sessionId: string; eventSeq: number | null; running: boolean; errorCount: number }> };
  let previous: PreviousState | null = null;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')) as PreviousState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const root = records.find(row => row.sessionId === requestedSession);
  complete = Boolean(root && records.length && records.every(row => !row.running));
  let progress = false;
  if (previous) {
    for (const row of records) {
      const old = previous.sessions.find(item => item.sessionId === row.sessionId);
      if (!old) {
        changes.push(`Subagent/session started: ${row.sessionId}`);
        if (row.errorCount >= 3) alerts.push(`New subagent already has ${row.errorCount} model errors: ${row.sessionId}`);
        progress = true;
        continue;
      }
      if (row.eventSeq !== old.eventSeq) progress = true;
      if (old.running && !row.running) changes.push(`Session finished: ${row.sessionId}`);
      if (row.errorCount > old.errorCount) {
        const count = row.errorCount - old.errorCount;
        changes.push(`${count} new model error(s) in ${row.sessionId}`);
        if (count >= 3) alerts.push(`Repeated new model errors in ${row.sessionId}: ${count}`);
      }
    }
    if (previous.bridgeHealthy && !bridgeHealthy) alerts.push('QoderBridge became unavailable');
    if (previous.bridgePort && previous.bridgePort !== bridgePort)
      changes.push(`Harness provider switched from port ${previous.bridgePort} to ${bridgePort}`);
    if (complete) alerts.push('Root task and tracked child sessions finished');
    if (!progress && records.some(row => row.running) &&
      Date.now() - Date.parse(previous.lastProgressAt) >= 15 * 60_000)
      alerts.push('No new DSH event sequence for at least 15 minutes');
  }
  await writeFile(statePath, JSON.stringify({ bridgeHealthy, bridgePort, lastProgressAt: progress || !previous
    ? checkedAt : previous.lastProgressAt,
    sessions: records.map(row => ({ sessionId: row.sessionId, eventSeq: row.eventSeq,
      running: row.running, errorCount: row.errorCount })) }, null, 2));
}
console.log(JSON.stringify({ checkedAt, bridgeHealthy, bridgePort, bridgeURL: baseURL ?? null,
  targetSession: requestedSession ?? null, activeCount: records.filter(row => row.running).length,
  complete, changes, alerts, sessions: records }, null, 2));
