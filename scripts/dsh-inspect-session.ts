import { rpc } from './dsh-rpc.js';
const id = process.argv[2];
if (!id?.startsWith('session-')) throw new Error('Pass test session ID');
const result = await rpc('session/list', { _request: {} });
const item = result.items?.find((row: { sessionId: string }) => row.sessionId === id);
console.log(JSON.stringify({ keys: Object.keys(result), item: item ?? null }));
