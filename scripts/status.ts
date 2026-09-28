import { readFile } from 'node:fs/promises';
import { PUBLIC_MODEL } from '../src/server.js';
import { BRIDGE_MODELS } from '../src/model.js';
let health: { status?: string; pid?: number; model?: string } = {};
let described: any; let catalog: any;
try {
  const { rpc } = await import('./dsh-rpc.js');
  [described, catalog] = await Promise.all([rpc('settings/describe'), rpc('session/modelCatalog')]);
} catch { /* DSH may be closed while the Bridge is healthy. */ }
let savedBaseURL: string | undefined;
try { savedBaseURL = JSON.parse(await readFile('.runtime/last-bridge.json', 'utf8')).baseURL; }
catch { /* No prior successful switchover. */ }
const liveBaseURL = described?.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai')
  ?.value?.providers?.qoderbridge?.baseURL as string | undefined;
const baseURL = liveBaseURL ?? savedBaseURL;
const bridgeOrigin = baseURL ? new URL(baseURL).origin : 'http://127.0.0.1:8646';
try {
  const response = await fetch(`${bridgeOrigin}/health`, { signal: AbortSignal.timeout(3000) });
  if (response.ok) health = await response.json();
} catch { /* Offline Bridge is a status result, not a CLI crash. */ }
const group = catalog?.groups.find((entry: { id: string }) => entry.id === 'qoderbridge');
const modelPresent = catalog ? group?.models?.some((entry: { id: string }) => entry.id === PUBLIC_MODEL) === true : null;
const defaultActive = catalog ? catalog.default.provider === 'qoderbridge' && BRIDGE_MODELS.some(model => model.id === catalog.default.model) : null;
console.log(JSON.stringify({ bridgeHealthy: health.status === 'ok', bridgePid: health.pid ?? null,
  bridgeURL: baseURL ?? null, bridgeURLSource: liveBaseURL ? 'harness' : savedBaseURL ? 'last-confirmed' : 'default',
  harnessResponding: Boolean(catalog && described),
  harnessProviderVisible: catalog ? Boolean(group) : null, modelPresent, defaultActive,
  model: catalog?.default?.provider === 'qoderbridge' ? catalog.default.model : PUBLIC_MODEL,
  availableBridgeModels: group?.models?.map((model: { id: string }) => model.id) ?? [] }, null, 2));
if (health.status !== 'ok' || !catalog || !modelPresent || !defaultActive) process.exitCode = 1;
