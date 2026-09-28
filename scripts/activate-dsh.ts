import { mkdir, writeFile } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
import { PUBLIC_MODEL } from '../src/server.js';
const catalog = await rpc('session/modelCatalog');
if (!catalog.groups.some((group: { id: string; models: Array<{ id: string }> }) =>
  group.id === 'qoderbridge' && group.models.some(model => model.id === PUBLIC_MODEL)))
  throw new Error('QoderBridge is not in the Harness model catalog');
const described = await rpc('settings/describe');
const row = described.namespaces.find((entry: { ns: string }) => entry.ns === 'agent-default-model');
if (!row) throw new Error('Default model settings not found');
await mkdir('reports', { recursive: true });
await writeFile('reports/dsh-default-before.json', JSON.stringify({ capturedAt: new Date().toISOString(),
  user: row.user ?? null, revision: row.revision }, null, 2));
if (row.value?.provider !== 'qoderbridge' || row.value?.model !== PUBLIC_MODEL || row.value?.reasoningEffort !== undefined) {
  await rpc('settings/mutate', { ns: 'agent-default-model', expectedRevision: row.revision, ops: [
    { op: 'set', path: ['provider'], value: 'qoderbridge' },
    { op: 'set', path: ['model'], value: PUBLIC_MODEL },
    { op: 'unset', path: ['reasoningEffort'] },
  ] });
}
const updated = await rpc('session/modelCatalog');
if (updated.default.provider !== 'qoderbridge' || updated.default.model !== PUBLIC_MODEL)
  throw new Error(`Default model was not activated: ${JSON.stringify(updated.default)}`);
console.log(JSON.stringify({ activeDefault: updated.default, previousDefault: catalog.default }));
