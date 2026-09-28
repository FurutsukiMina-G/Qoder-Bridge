import { rpc } from './dsh-rpc.js';
const described = await rpc('settings/describe');
const row = described.namespaces.find((entry: { ns: string }) => entry.ns === 'agent-default-model');
console.log(JSON.stringify({ value: row?.value, user: row?.user ?? null, base: row?.base ?? null, revision: row?.revision }));
