export type MonitorSession = { sessionId: string; parentSessionId?: string | null; running: boolean;
  eventSeq: number | null; errorCount: number; pendingApprovalSeq?: number | null; lastModelStatus?: string | null };
export type MonitorState = { bridgeHealthy: boolean; bridgePort?: number; lastProgressAt: string; sessions: MonitorSession[] };
export function pendingApproval(events: Array<{ type: string; seq: number; data?: { id?: string } }>): number | null {
  const pending = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'approval/asked' && event.data?.id) pending.set(event.data.id, event.seq);
    if (event.type === 'approval/decided' && event.data?.id) pending.delete(event.data.id);
  }
  return [...pending.values()].at(-1) ?? null;
}
export function monitorSignals(records: MonitorSession[], previous: MonitorState | null, options: {
  rootId: string; now: number; bridgeHealthy: boolean; bridgePort: number; activeRequests: number | null;
}) {
  const changes: string[] = [], alerts: string[] = [];
  const root = records.find(row => row.sessionId === options.rootId);
  const allStopped = Boolean(root && records.length && records.every(row => !row.running));
  const running = records.filter(row => row.running);
  const parents = new Map(records.map(row => [row.sessionId, row.parentSessionId]));
  const descendant = (child: string, parent: string) => {
    const visited = new Set<string>();
    let cursor = parents.get(child);
    while (cursor && !visited.has(cursor)) {
      if (cursor === parent) return true;
      visited.add(cursor); cursor = parents.get(cursor);
    }
    return false;
  };
  const leaves = running.filter(row => !running.some(other => descendant(other.sessionId, row.sessionId)));
  const waiting = Boolean(leaves.length && options.activeRequests === 0 && leaves.every(row => row.pendingApprovalSeq));
  let progress = !previous;
  for (const row of records) {
    const old = previous?.sessions.find(item => item.sessionId === row.sessionId);
    if (!old) {
      progress = true;
      if (previous) changes.push(`Subagent/session started: ${row.sessionId}`);
      if (previous && row.errorCount >= 3) alerts.push(`New session already has ${row.errorCount} model errors: ${row.sessionId}`);
    } else {
      if (row.eventSeq !== old.eventSeq) progress = true;
      if (old.running && !row.running) changes.push(`Session stopped: ${row.sessionId}`);
      const count = row.errorCount - old.errorCount;
      if (count > 0) changes.push(`${count} new model error(s) in ${row.sessionId}`);
      if (count >= 3) alerts.push(`Repeated new model errors in ${row.sessionId}: ${count}`);
    }
    if (row.pendingApprovalSeq && row.pendingApprovalSeq !== old?.pendingApprovalSeq)
      alerts.push(`Harness approval required: ${row.sessionId} at event ${row.pendingApprovalSeq}`);
  }
  if (!options.bridgeHealthy && (!previous || previous.bridgeHealthy)) alerts.push('QoderBridge unavailable');
  if (previous?.bridgePort && previous.bridgePort !== options.bridgePort)
    changes.push(`Harness provider switched from port ${previous.bridgePort} to ${options.bridgePort}`);
  const wasStopped = previous?.sessions.some(row => row.sessionId === options.rootId) && previous.sessions.every(row => !row.running);
  if (allStopped && previous && !wasStopped) alerts.push('Root and tracked children stopped; inspect turn/end and delivery');
  if (previous && !progress && running.length && !waiting && options.now - Date.parse(previous.lastProgressAt) >= 15 * 60_000)
    alerts.push('No new DSH event sequence for at least 15 minutes');
  const outcome = !root ? 'missing_root' : allStopped ? root.lastModelStatus === 'error' ? 'stopped_after_model_error' : 'stopped_needs_review'
    : waiting ? 'waiting_for_approval' : 'running';
  return { changes, alerts, allStopped, outcome, lastProgressAt: progress ? new Date(options.now).toISOString() : previous!.lastProgressAt };
}
