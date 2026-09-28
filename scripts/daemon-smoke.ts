import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startDaemon, qodercliAuth, query } from '@qodercn-ai/qodercn-agent-sdk';
import { baseOptions, type Config } from '../src/client.js';
const config: Config = { auth: 'cli', timeout: 90000, strategy: 'permission',
  system: 'Answer directly.', sessionSettings: JSON.stringify({ enabledPlugins: { 'qoder-context@qoderapp-bundler': false } }) };
await mkdir('.runtime', { recursive: true });
const start = performance.now();
const daemon = await startDaemon({ auth: qodercliAuth(), cwd: resolve('.runtime'),
  env: { ...process.env, QODERCN_EXPOSE_REQUEST_ID: 'true' }, initializeTimeoutMs: 90000 });
console.log(JSON.stringify({ stage: 'daemon-ready', ms: performance.now() - start }));
try {
  const catalog = await daemon.getModels();
  const model = catalog.find(m => m.isEnabled !== false && /DeepSeek-Flash/i.test(m.displayName));
  if (!model) throw new Error('DeepSeek Flash unavailable');
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const options = baseOptions(config, controller);
    delete options.auth;
    delete options.env;
    options.daemon = daemon;
    options.model = model.value;
    const begun = performance.now();
    let answer = '';
    for await (const message of query({ prompt: `Reply exactly DAEMON_${i}.`, options })) {
      if (message.type === 'result' && message.subtype === 'success') answer = message.result;
    }
    console.log(JSON.stringify({ stage: 'query', i, ms: performance.now() - begun, answer }));
  }
} finally { await daemon.stop(); }
