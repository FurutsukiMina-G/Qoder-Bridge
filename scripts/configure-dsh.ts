import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
import { PUBLIC_MODEL } from '../src/server.js';
import { BRIDGE_MODELS } from '../src/model.js';

const bridgeBase = 'http://127.0.0.1:8646/v1';
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const health = await fetch('http://127.0.0.1:8646/health');
if (!health.ok) throw new Error('QoderBridge is not running');
const models = await fetch(`${bridgeBase}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!models.ok || !(await models.json()).data.some((m: { id: string }) => m.id === PUBLIC_MODEL))
  throw new Error('QoderBridge model endpoint is unavailable');
const described = await rpc('settings/describe');
const row = described.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai');
if (!row || !described.writable) throw new Error('Harness does not expose writable llm-pi-ai settings');
const previous = row.user?.providers?.qoderbridge;
if (previous && (previous.baseURL !== bridgeBase || previous.apiKeyEnv !== 'QODERBRIDGE_LOCAL_KEY'))
  throw new Error('Existing qoderbridge provider differs; refusing to overwrite it');
await mkdir('reports', { recursive: true });
await writeFile('reports/dsh-settings-before.json', JSON.stringify({ capturedAt: new Date().toISOString(),
  namespace: row.ns, user: row.user ?? null, revision: row.revision }, null, 2));
const provider = {
  displayName: 'Qoder DeepSeek', apiKeyEnv: 'QODERBRIDGE_LOCAL_KEY',
  api: 'openai-completions', baseURL: bridgeBase, cacheRetention: 'long',
  compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true,
    supportsLongCacheRetention: true, maxTokensField: 'max_tokens' },
  models: BRIDGE_MODELS.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow,
    maxTokens: model.maxTokens, input: ['text'], reasoningEfforts: false })),
};
await rpc('credentials/set', { ref: 'QODERBRIDGE_LOCAL_KEY', value: key });
if (!previous) await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision,
  ops: [{ op: 'set', path: ['providers', 'qoderbridge'], value: provider }] });
else {
  const existing = previous.models ?? [];
  const additions = provider.models.filter(model => !existing.some((old: { id: string }) => old.id === model.id));
  const ops = [];
  if (additions.length) ops.push({ op: 'set', path: ['providers', 'qoderbridge', 'models'], value: [...existing, ...additions] });
  if (previous.displayName === 'Qoder DeepSeek Flash')
    ops.push({ op: 'set', path: ['providers', 'qoderbridge', 'displayName'], value: 'Qoder DeepSeek' });
  if (ops.length) await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision, ops });
}
const catalog = await rpc('session/modelCatalog');
const group = catalog.groups?.find((g: { id: string }) => g.id === 'qoderbridge');
if (!group || !BRIDGE_MODELS.every(model => group.models.some((m: { id: string }) => m.id === model.id)))
  throw new Error(`Provider not present in Harness catalog: ${JSON.stringify(catalog.failures ?? [])}`);
console.log(JSON.stringify({ configured: true, provider: group.id, model: PUBLIC_MODEL,
  catalog_models: group.models.map((m: { id: string }) => m.id), check: randomUUID().slice(0, 8) }));
