import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { rpc } from './dsh-rpc.js';
import { bridgeModel } from '../src/model.js';

const [backupPath, casesPath, shellPath] = process.argv.slice(2);
const setupFailureIds = process.argv.slice(5);
assert.ok(backupPath && casesPath && shellPath, 'Pass backup, test cases JSON, and extracted current shell paths');
const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'));
const baseline = JSON.parse(await readFile(join(backupPath, 'harness-baseline.json'), 'utf8'));
const readRows = async (path: string) => (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const [tasks, bridge, list, catalog] = await Promise.all([
  readRows('reports/tasks.ndjson'), readRows('reports/bridge.ndjson'),
  rpc('session/list', { _request: {} }), rpc('session/modelCatalog'),
]);
assert.ok(baseline.sessionIds.every((id: string) => list.items.some((item: any) => item.sessionId === id)), 'Every prior visible session must remain available');
assert.deepEqual(catalog.default, baseline.default, 'The original default model must be retained');
const homeRoot = manifest.roots.find((root: any) => root.id === 'harness-home').path;
const sessionFiles = manifest.files.filter((file: any) => file.root === 'harness-home' && file.path.startsWith('sessions'));
let appendedFiles = 0;
for (const file of sessionFiles) {
  const before: Buffer = await readFile(join(backupPath, 'harness-home', file.path));
  const current = await readFile(join(homeRoot, file.path));
  assert.ok(before.equals(current.subarray(0, before.length)), 'The complete original session history must remain byte-for-byte intact');
  if (current.length > before.length) appendedFiles++;
}
const credentials = manifest.files.filter((file: any) => file.root === 'harness-home' && file.path.endsWith('.credentials.yaml'));
for (const file of credentials)
  assert.equal(createHash('sha256').update(await readFile(join(homeRoot, file.path))).digest('hex'), file.sha256, 'Credentials must remain intact');
const cases = JSON.parse(await readFile(casesPath, 'utf8'));
const results = [];
for (const sample of cases) {
  const item = list.items.find((entry: any) => entry.sessionId === sample.sessionId);
  assert.ok(item && !item.running, 'Smoke session must have finished');
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: sample.sessionId },
    throughSeq: item.projections.asOfSeq, maxMessages: 100 } });
  const events = page.records.map((record: any) => record.event ?? record);
  const calls = events.filter((event: any) => event.type === 'tool/call');
  const toolCall = calls.find((event: any) => sample.tool === 'pwsh'
    ? /pwsh|powershell/i.test(event.data.name) : event.data.name === sample.tool);
  assert.ok(toolCall, 'Required native tool must have executed');
  assert.ok(events.some((event: any) => event.type === 'tool/result' &&
    event.data.message?.toolCallId === toolCall.data.callId && JSON.stringify(event.data).includes(sample.marker)), 'Tool output must contain the private sentinel');
  assert.ok(events.some((event: any) => event.type === 'assistant/message' &&
    event.data.message?.content?.some((part: any) => part.type === 'text' && part.text.trim() === sample.marker)), 'Final answer must match the tool output');
  assert.ok(events.some((event: any) => event.type === 'turn/end' && event.data.reason?.kind === 'completed'));
  const hash = createHash('sha256').update(sample.sessionId).digest('hex').slice(0, 12);
  const rows = tasks.filter(row => row.harness_session_key_hash === hash);
  assert.ok(rows.length >= 2 && rows.every(row => row.status === 'success' && typeof row.telemetry.credits_delta === 'number'), 'All real model requests must succeed and report Credits');
  const ids = new Set(rows.map(row => row.bridge_request_id));
  const turns = bridge.filter(row => ids.has(row.bridge_request_id));
  assert.equal(turns.length, rows.length);
  assert.equal(new Set(turns.map(row => row.session_id)).size, 1, 'Tool continuation must reuse its own Qoder session');
  const model = bridgeModel(sample.model)!;
  assert.ok(turns.every(row => row.model === model.runtimeId && row.model_policy_calls?.every((policy: any) =>
    policy.model === model.runtimeId && policy.context_window === 1_000_000 && policy.reasoning_effort === 'max')));
  const stats = item.projections.values.sessionStats;
  assert.ok(stats.decodeTokens > 0 && stats.decodeMs > 0, 'Harness must receive token and decoding-time statistics');
  results.push({ sessionId: sample.sessionId, model: sample.model, nativeTools: calls.map((event: any) => event.data.name),
    toolOutputVerified: true, finalAnswerVerified: true, completed: true, modelRequests: rows.length, modelErrors: 0,
    qoderSession: turns[0].session_id,
    actualResponseModels: [...new Set(turns.flatMap(row => row.requests?.map((request: any) => request.model) ?? []))],
    credits: rows.reduce((sum, row) => sum + row.telemetry.credits_delta, 0),
    usage: item.projections.values.tokenUsage, contextPressure: item.projections.values.contextPressure,
    decodeTokens: stats.decodeTokens, decodeMs: stats.decodeMs, tokensPerSecond: stats.decodeTokens / stats.decodeMs * 1000,
    streaming: rows.map(row => ({ firstTextMs: row.telemetry.first_client_text_ms ?? null,
      firstThinkingMs: row.telemetry.first_client_thinking_ms ?? null, chunks: row.telemetry.stream_chunks ?? null })),
  });
}
assert.equal(new Set(results.map(row => row.qoderSession)).size, results.length, 'Separate Harness sessions/models must have independent Qoder histories');
const desktopPackage = JSON.parse(await readFile(resolve(shellPath, 'package.json'), 'utf8'));
const adapter = JSON.parse(await readFile('reports/adapter-smoke.json', 'utf8'));
const setupFailures = setupFailureIds.map(sessionId => {
  assert.ok(!list.items.find((item: any) => item.sessionId === sessionId)?.running, 'Discarded setup test must be stopped');
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  const rows = tasks.filter(row => row.harness_session_key_hash === hash);
  return { sessionId, cause: 'Temporary fixture lacked the signed-in user permissions needed by the native Windows sandbox; corrected only on a separate test fixture',
    stopped: true, modelRequests: rows.length, modelErrors: rows.filter(row => row.status === 'error').length,
    credits: rows.every(row => typeof row.telemetry.credits_delta === 'number')
      ? rows.reduce((sum, row) => sum + row.telemetry.credits_delta, 0) : null };
});
const report = { checkedAt: new Date().toISOString(), desktopVersion: desktopPackage.version,
  desktopBuildCommit: desktopPackage.dshBuildCommit, adapterVersion: adapter.adapterVersion,
  originalSessionsPreserved: baseline.sessionIds.length, sessionFilesPreserved: sessionFiles.length,
  filesWithSafeAppend: appendedFiles, credentialsIntact: true, defaultModel: catalog.default,
  backup: resolve(backupPath), adapterChecks: adapter.checks.map((entry: any) => ({ testCase: entry.testCase, terminalEvent: entry.terminalEvent })),
  tests: results, setupFailures,
  testCredits: results.reduce((sum, row) => sum + row.credits, 0) + setupFailures.reduce((sum, row) => sum + (row.credits ?? 0), 0),
  bridgeHealth: await fetch('http://127.0.0.1:8646/health').then(response => response.json()),
};
const backupDate = basename(resolve(backupPath)).match(/^update-backup-(\d{8})$/)?.[1] ?? 'latest';
await writeFile(`reports/desktop-update-${backupDate}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
