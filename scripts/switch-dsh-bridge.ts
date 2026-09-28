import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { rpc } from './dsh-rpc.js';
const port = Number(process.argv[2] ?? '8646');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid target port');
const target = `http://127.0.0.1:${port}/v1`;
const origin = new URL(target).origin;
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const [health, models] = await Promise.all([
  fetch(`${origin}/health`),
  fetch(`${target}/models`, { headers: { authorization: `Bearer ${key}` } }),
]);
if (!health.ok || !models.ok || !(await models.json()).data?.some((m: { id: string }) => m.id === 'qoder-deepseek-flash'))
  throw new Error('Target Bridge is not healthy or lacks authenticated model listing');
const described = await rpc('settings/describe');
const row = described.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai');
const current = row?.user?.providers?.qoderbridge;
if (!row || !current || current.api !== 'openai-completions' ||
  !String(current.baseURL).startsWith('http://127.0.0.1:')) throw new Error('Current local Provider is unexpected');
const previousBase = current.baseURL;
await mkdir('reports', { recursive: true });
await writeFile(`reports/dsh-provider-before-switchover-${port}.json`, JSON.stringify({
  capturedAt: new Date().toISOString(), revision: row.revision, provider: current,
}, null, 2));
if (previousBase !== target) await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: row.revision,
  ops: [{ op: 'set', path: ['providers', 'qoderbridge', 'baseURL'], value: target }] });
const after = await rpc('settings/describe');
const updated = after.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai')?.value?.providers?.qoderbridge;
const catalog = await rpc('session/modelCatalog');
if (updated?.baseURL !== target || !catalog.groups.some((group: { id: string }) => group.id === 'qoderbridge'))
  throw new Error('Harness Provider did not retain the target Bridge route');
await writeFile('.runtime/last-bridge.json', JSON.stringify({ baseURL: target,
  verifiedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ previousBase, currentBase: target, providerVisible: true }));
