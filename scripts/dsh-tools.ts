import { rpc } from './dsh-rpc.js';
const sessionId = process.argv[2];
if (!sessionId?.startsWith('session-')) throw new Error('Pass test session ID');
const list = await rpc('session/list', { _request: {} });
const item = list.items.find((s: { sessionId: string }) => s.sessionId === sessionId);
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId },
  throughSeq: item.projections.asOfSeq, maxMessages: 100 } });
const header = page.records.map((r: { event?: { type: string; data?: { header?: { tools?: Array<{ name: string }> } } }; type?: string; data?: unknown }) => r.event ?? r)
  .find((r: { type: string }) => r.type === 'request/header');
console.log(JSON.stringify(header?.data?.header?.tools?.map((t: { name: string }) => t.name) ?? []));
