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
await writeFile(`reports/dsh-settings-before-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
  capturedAt: new Date().toISOString(), namespace: row.ns, user: row.user ?? null, revision: row.revision }, null, 2));
// Each declared level is offered in the Harness model picker and sent as OpenAI-style reasoning_effort;
// each context window is its own model entry so the picker switches it together with compaction.
const offered = BRIDGE_MODELS.map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow,
  maxTokens: model.maxTokens, input: ['text'],
  reasoningEfforts: Object.fromEntries(model.efforts.map(effort => [effort, effort])) }));
const compat = { supportsDeveloperRole: false, supportsUsageInStreaming: true, supportsLongCacheRetention: true,
  maxTokensField: 'max_tokens', supportsReasoningEffort: true };
const provider = { displayName: 'Qoder DeepSeek', apiKeyEnv: 'QODERBRIDGE_LOCAL_KEY', api: 'openai-completions',
  baseURL: bridgeBase, cacheRetention: 'long', reasoning: 'max', compat, models: offered };
await rpc('credentials/set', { ref: 'QODERBRIDGE_LOCAL_KEY', value: key });
if (!previous) await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision,
  ops: [{ op: 'set', path: ['providers', 'qoderbridge'], value: provider }] });
else {
  // Keep user-only additions, refresh the bridge's own entries and switches.
  const ownIds = new Set(offered.map(model => model.id));
  const extra = (previous.models ?? []).filter((old: { id: string }) => !ownIds.has(old.id));
  const ops: unknown[] = [
    { op: 'set', path: ['providers', 'qoderbridge', 'models'], value: [...offered, ...extra] },
    { op: 'set', path: ['providers', 'qoderbridge', 'compat'], value: { ...previous.compat, ...compat } },
  ];
  if (previous.reasoning === undefined) ops.push({ op: 'set', path: ['providers', 'qoderbridge', 'reasoning'], value: 'max' });
  if (previous.displayName === 'Qoder DeepSeek Flash')
    ops.push({ op: 'set', path: ['providers', 'qoderbridge', 'displayName'], value: 'Qoder DeepSeek' });
  await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision, ops });
}
const catalog = await rpc('session/modelCatalog');
const group = catalog.groups?.find((g: { id: string }) => g.id === 'qoderbridge');
if (!group || !BRIDGE_MODELS.every(model => group.models.some((m: { id: string }) => m.id === model.id)))
  throw new Error(`Provider not present in Harness catalog: ${JSON.stringify(catalog.failures ?? [])}`);
console.log(JSON.stringify({ configured: true, provider: group.id, default: catalog.default,
  catalog_models: group.models.map((m: { id: string }) => m.id), check: randomUUID().slice(0, 8) }));
