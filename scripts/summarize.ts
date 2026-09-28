import { readFile } from 'node:fs/promises';
const file = process.argv[2] ?? 'reports/telemetry.ndjson';
const reports = (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
console.table(reports.map(r => ({
  timestamp: r.timestamp, mode: r.mode, strategy: r.strategy ?? '', model: r.model,
  calls: r.model_requests, wall_ms: r.wall_ms === null ? null : Math.round(r.wall_ms),
  api_ms: r.api_ms, session_credits: r.total_session_credits,
  behavior: r.gate?.behavior_passed ?? null, gate: r.gate?.interception_passed ?? null,
  history: r.gate?.session_history_clean ?? '', error: r.error,
})));
