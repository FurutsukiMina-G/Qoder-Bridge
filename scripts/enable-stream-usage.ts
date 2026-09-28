import { rpc } from './dsh-rpc.js';
const settings = await rpc('settings/describe');
const row = settings.namespaces.find((entry: { ns: string }) => entry.ns === 'llm-pi-ai');
const provider = row?.value?.providers?.qoderbridge;
if (provider?.baseURL !== 'http://127.0.0.1:8646/v1' || provider?.api !== 'openai-completions')
  throw new Error('Unexpected active QoderBridge route');
if (provider.compat?.supportsUsageInStreaming !== true) await rpc('settings/mutate', {
  ns: 'llm-pi-ai', expectedRevision: row.revision,
  ops: [{ op: 'set', path: ['providers', 'qoderbridge', 'compat', 'supportsUsageInStreaming'], value: true }],
});
console.log(JSON.stringify({ updated: true, field: 'supportsUsageInStreaming', value: true }));
