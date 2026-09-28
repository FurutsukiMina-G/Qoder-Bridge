import { rpc } from './dsh-rpc.js';
const id = process.argv[2];
if (!id?.startsWith('session-')) throw new Error('Pass test session ID');
const list = await rpc('session/list', { _request: {} });
const item = list.items?.find((row: { sessionId: string }) => row.sessionId === id);
if (!item) throw new Error('Session not found');
const throughSeq = item.projections?.asOfSeq;
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq, maxMessages: 120 } });
const records = page.records.map((r: Record<string, unknown>) => {
  const e = (r.event ?? r) as Record<string, unknown>;
  const data = (e.data ?? e.payload ?? {}) as Record<string, unknown>;
  return { seq: e.seq ?? r.seq, type: e.type ?? r.type, keys: Object.keys(e),
    data: JSON.stringify(data).slice(0, 360) };
});
console.log(JSON.stringify({ running: item.running, throughSeq, records, hasMore: page.hasMore }, null, 2));
