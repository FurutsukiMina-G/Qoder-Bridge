import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorSignals, pendingApproval, type MonitorSession, type MonitorState } from '../src/monitor-state.js';
import { diagnosticSummary } from '../src/diagnostics.js';
import { ChatRequest, parseDecision } from '../src/compat.js';
const now = Date.parse('2026-10-02T15:00:00Z');
const options = { rootId: 'root', now, bridgeHealthy: true, bridgePort: 8646, activeRequests: 0 };
const root: MonitorSession = { sessionId: 'root', running: true, eventSeq: 1149, errorCount: 8, pendingApprovalSeq: 1149 };
const prior = (sessions: MonitorSession[]): MonitorState => ({ bridgeHealthy: true, bridgePort: 8646,
  lastProgressAt: new Date(now - 20 * 60_000).toISOString(), sessions });
test('the actual unchanged approval wait is not a stall and does not repeat approval notifications', () => {
  const unchanged = monitorSignals([root], prior([root]), options);
  assert.equal(unchanged.outcome, 'waiting_for_approval');
  assert.deepEqual(unchanged.alerts, []);
  const first = monitorSignals([root], prior([{ ...root, pendingApprovalSeq: null }]), options);
  assert.equal(first.alerts.length, 1); assert.match(first.alerts[0]!, /approval required/);
  assert.equal(pendingApproval([{ type: 'approval/asked', seq: 1149, data: { id: 'test' } },
    { type: 'approval/decided', seq: 1150, data: { id: 'test' } }]), null);
});
test('a parent waiting for an approval-blocked child does not make the group appear stalled', () => {
  const child = { ...root, sessionId: 'child', parentSessionId: 'root' };
  const parent = { ...root, pendingApprovalSeq: null };
  assert.deepEqual(monitorSignals([parent, child], prior([parent, child]), options).alerts, []);
  assert.match(monitorSignals([parent], prior([parent]), options).alerts[0]!, /15 minutes/);
  const progressed = monitorSignals([{ ...parent, eventSeq: 1151 }], prior([parent]), options);
  assert.deepEqual(progressed.alerts, []);
});
test('stopping after a model error is a review state and the stop alert is emitted once', () => {
  const stopped = { ...root, running: false, pendingApprovalSeq: null, lastModelStatus: 'error' };
  const result = monitorSignals([stopped], prior([root]), options);
  assert.equal(result.allStopped, true); assert.equal(result.outcome, 'stopped_after_model_error');
  assert.equal(result.alerts.length, 1); assert.match(result.alerts[0]!, /inspect/);
  assert.deepEqual(monitorSignals([stopped], prior([stopped]), options).alerts, []);
});
test('historical corrupted tool-name errors do not expose appended commands or code', () => {
  assert.equal(diagnosticSummary('Unknown or unselected tool name: pwsh</｜｜DSML｜｜ parameter>{"command":"PRIVATE_CODE"}'),
    'Unknown or unselected tool name: [malformed tool name]');
  assert.equal(diagnosticSummary('Unknown or unselected tool name: unknown_tool'), 'Unknown or unselected tool name: unknown_tool');
  const request = ChatRequest.parse({ model: 'qoder-deepseek-flash', messages: [{ role: 'user', content: 'fixture' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  assert.throws(() => parseDecision(JSON.stringify({ kind: 'tool_call', name: 'pwsh</parameter>{PRIVATE_CODE}', arguments: {} }), request),
    error => error instanceof Error && error.message === 'Unknown or unselected tool name: [malformed tool name]');
});
