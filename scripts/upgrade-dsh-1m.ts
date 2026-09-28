import { mkdir, writeFile } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
import { PUBLIC_MODEL } from '../src/server.js';
const described = await rpc('settings/describe');
const row = described.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai');
const provider = row?.user?.providers?.qoderbridge;
if (!row || !provider || provider.api !== 'openai-completions' ||
    provider.baseURL !== 'http://127.0.0.1:8646/v1') throw new Error('Expected local qoderbridge provider was not found');
const models = provider.models;
if (!Array.isArray(models) || !models.some((m: { id: string }) => m.id === PUBLIC_MODEL))
  throw new Error('Bridge model is missing from current provider settings');
await mkdir('reports', { recursive: true });
await writeFile('reports/dsh-provider-before-1m.json', JSON.stringify({ capturedAt: new Date().toISOString(),
  previous: provider, revision: row.revision }, null, 2));
const updatedModels = models.map((m: { id: string }) => m.id === PUBLIC_MODEL ? { ...m, contextWindow: 1_000_000 } : m);
await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision, ops: [
  { op: 'set', path: ['providers', 'qoderbridge', 'models'], value: updatedModels },
  { op: 'set', path: ['providers', 'qoderbridge', 'cacheRetention'], value: 'long' },
  { op: 'set', path: ['providers', 'qoderbridge', 'compat', 'supportsLongCacheRetention'], value: true },
] });
const after = await rpc('settings/describe');
const current = after.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai')?.value?.providers?.qoderbridge;
if (current?.models?.find((m: { id: string }) => m.id === PUBLIC_MODEL)?.contextWindow !== 1_000_000 ||
    current.cacheRetention !== 'long' || current.compat?.supportsLongCacheRetention !== true)
  throw new Error('Harness provider did not retain 1M context and session identity settings');
console.log(JSON.stringify({ contextWindow: 1_000_000, cacheRetention: current.cacheRetention,
  sessionKeySupported: current.compat.supportsLongCacheRetention }));
