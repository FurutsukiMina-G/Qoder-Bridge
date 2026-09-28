import { rpc } from './dsh-rpc.js';
const sessionId = process.argv[2];
if (!sessionId?.startsWith('session-')) throw new Error('Usage: analyze-harness-context <Harness session ID>');
const list = await rpc('session/list', { _request: {} });
const item = list.items.find((x: { sessionId: string }) => x.sessionId === sessionId);
if (!item) throw new Error('Test session unavailable');
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: item.projections.asOfSeq, maxMessages: 120 } });
const events = page.records.map((r: { event: { type: string; data?: Record<string, unknown> } }) => r.event);
const headers = events.filter((e: { type: string }) => e.type === 'request/header');
const reports = headers.map((event: { data: { turn: number; step: number; header: { tools: Array<{ name: string; description?: string; parameters?: unknown }> } } }) => {
  const tools = event.data.header.tools;
  const rows = tools.map(t => ({ name: t.name, descriptionChars: t.description?.length ?? 0,
    schemaChars: JSON.stringify(t.parameters ?? {}).length }));
  return { turn: event.data.turn, step: event.data.step, toolCount: tools.length,
    descriptionChars: rows.reduce((n, r) => n + r.descriptionChars, 0),
    schemaChars: rows.reduce((n, r) => n + r.schemaChars, 0),
    largestTools: rows.sort((a, b) => b.descriptionChars + b.schemaChars - a.descriptionChars - a.schemaChars).slice(0, 8) };
});
console.log(JSON.stringify(reports, null, 2));
