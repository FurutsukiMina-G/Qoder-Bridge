import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
import { diagnosticSummary } from '../src/diagnostics.js';
import { monitorSignals, pendingApproval, type MonitorState } from '../src/monitor-state.js';
import {requestAccounting} from '../src/request-metrics.js';

type TaskEvent = {
  time: string; harness_session_key_hash: string | null; status: string; error: string | null;
  output?: { kind?: string; name?: string; calls?: Array<{ name: string }> } | null;
  telemetry?: { credits_delta?: number | null; wall_ms?: number | null; local_response_replay?: boolean;
    model_requests?:number|null;decision_recovery?:{knownCreditsSubtotal?:number;correctionCalls?:number;outcome?:string}|null };
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
const statePath = requestedSession ? `.runtime/monitor-state-${createHash('sha256').update(requestedSession).digest('hex').slice(0, 12)}.json` : null;
let previous: MonitorState | null = null;
if (statePath) try { previous = JSON.parse(await readFile(statePath, 'utf8')) as MonitorState; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
  const accounting=requestAccounting(turns);
  return {
    sessionId: item.sessionId, parentSessionId: item.parentSessionId ?? null,
    keyHash: key, cwd: item.cwd ?? null,
    title: values.title ?? null, running: item.running, eventSeq: item.projections?.asOfSeq ?? null,
    turns: values.sessionStats?.turns ?? null, steps: values.sessionStats?.steps ?? null,
    lastPromptAt: values.sessionListMetadata?.lastPromptAt ?? null,
    modelRequests: accounting.upstreamModelRequestCountUnknown?null:accounting.upstreamModelRequestsKnown,
    bridgeRequests:accounting.bridgeRequests,upstreamModelRequestsKnown:accounting.upstreamModelRequestsKnown,
    upstreamModelRequestCountUnknown:accounting.upstreamModelRequestCountUnknown,
    correctionCalls:accounting.correctionCalls,recoveredRequests:accounting.recoveredRequests,
    localReplays: turns.filter(turn => turn.telemetry?.local_response_replay).length,
    credits: credits.every(x => typeof x === 'number' && Number.isFinite(x)) ? credits.reduce<number>((sum, x) => sum + (x ?? 0), 0) : null,
    knownCredits: accounting.knownCredits,
    lastModelAt: last?.time ?? null, lastModelStatus: last?.status ?? null,
    lastToolDecision: last?.output?.kind === 'tool_call' ? last.output.name ?? null :
      last?.output?.kind === 'tool_calls' ? last.output.calls?.map(call => call.name).join(', ') ?? null : null,
    errorCount: errors.length, lastErrorAt: errors.at(-1)?.time ?? null,
    lastModelError: diagnosticSummary(errors.at(-1)?.error),
    pendingApprovalSeq: previous?.sessions.find(row => row.sessionId === item.sessionId && row.eventSeq === item.projections?.asOfSeq)?.pendingApprovalSeq ?? null,
    planActive: values.plan?.active ?? false,
    todoCount: Array.isArray(values.todos) ? values.todos.length : null,
  };
});
// Query only idle, running sessions whose pending approval is not already known.
// Normal model progress does not require fetching message history.
if (service?.activeRequests === 0 && service?.queuedRequests === 0) {
  const checks = await Promise.allSettled(records.filter(row => row.running && !row.pendingApprovalSeq).map(async row => {
    const item = relevant.find((entry: any) => entry.sessionId === row.sessionId);
    const address = item.parentSessionId ? { kind: 'subagent', parentSessionId: item.parentSessionId,
      childSessionId: item.sessionId, mode: item.projections.values.subagent.mode }
      : { kind: 'session', sessionId: item.sessionId };
    const page = await rpc('session/page', { request: { address, throughSeq: row.eventSeq, maxMessages: 20 } });
    row.pendingApprovalSeq = pendingApproval(page.records.map((record: any) => record.event ?? record));
  }));
  // Failure to inspect approvals must not imply that a task is blocked on one.
  if (checks.some(result => result.status === 'rejected')) process.stderr.write('Approval status unavailable for some sessions\n');
}
const checkedAt = new Date().toISOString();
const bridgeHealthy = service?.status === 'ok';
let changes: string[] = [];
let alerts: string[] = [];
let complete = false;
let outcome = 'untracked';
if (requestedSession && statePath) {
  const signals = monitorSignals(records, previous, { rootId: requestedSession, now: Date.parse(checkedAt),
    bridgeHealthy, bridgePort, activeRequests: service?.activeRequests ?? null });
  ({ changes, alerts, outcome } = signals);
  // Compatibility alias: all stopped is not evidence of successful business delivery.
  complete = signals.allStopped;
  await writeFile(statePath, JSON.stringify({ bridgeHealthy, bridgePort, lastProgressAt: signals.lastProgressAt,
    sessions: records.map(row => ({ sessionId: row.sessionId, parentSessionId: row.parentSessionId, eventSeq: row.eventSeq,
      running: row.running, errorCount: row.errorCount, lastModelStatus: row.lastModelStatus,
      pendingApprovalSeq: row.pendingApprovalSeq })) }, null, 2));
}
const output = { checkedAt, bridgeHealthy, bridgePort, bridgeURL: baseURL ?? null,
  bridgeActivity: { active: service?.activeRequests ?? null, queued: service?.queuedRequests ?? null },
  targetSession: requestedSession ?? null, activeCount: records.filter(row => row.running).length,
  complete, allStopped: complete, outcome, changes, alerts };
console.log(JSON.stringify({ ...output, ...(args.includes('--brief') ? {
  knownCredits: records.reduce((sum, row) => sum + Number(row.knownCredits), 0),
  unknownCreditSessions: records.filter(row => row.credits === null).length,
  sessions: records.filter(row => row.running || row.sessionId === requestedSession).map(row => ({
    sessionId: row.sessionId, eventSeq: row.eventSeq, running: row.running, modelRequests: row.modelRequests,
    bridgeRequests:row.bridgeRequests,upstreamModelRequestsKnown:row.upstreamModelRequestsKnown,
    upstreamModelRequestCountUnknown:row.upstreamModelRequestCountUnknown,
    correctionCalls:row.correctionCalls,recoveredRequests:row.recoveredRequests,
    errorCount: row.errorCount, pendingApprovalSeq: row.pendingApprovalSeq,
  })),
} : { sessions: records }) }, null, 2));
