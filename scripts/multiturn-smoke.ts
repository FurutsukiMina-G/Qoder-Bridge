import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startup, type SDKUserMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { baseOptions, type Config } from '../src/client.js';
import { InputQueue } from '../src/queue.js';
const config: Config = { auth: 'cli', timeout: 90000, strategy: 'permission', system: 'Answer directly.',
  sessionSettings: await readFile('config/thin-cn.json', 'utf8') };
await mkdir('.runtime', { recursive: true });
const queue = new InputQueue<SDKUserMessage>();
const start = performance.now();
const warm = await startup({ options: baseOptions(config, new AbortController()), initializeTimeoutMs: 90000 });
const q = warm.query(queue);
try {
  const models = await q.getAvailableModels();
  const flash = models.find(m => m.displayName === 'DeepSeek-Flash');
  if (!flash) throw new Error('Model unavailable');
  await q.setModel(flash.value);
  console.log(JSON.stringify({ stage: 'ready', ms: performance.now() - start }));
  for (let i = 0; i < 2; i++) {
    const begun = performance.now();
    queue.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: `Reply exactly MULTITURN_${i}.` } });
    let response = '';
    while (true) {
      const step = await q.next(); if (step.done) break;
      if (step.value.type === 'result') { response = step.value.subtype === 'success' ? step.value.result : step.value.subtype; break; }
    }
    console.log(JSON.stringify({ stage: 'turn', i, ms: performance.now() - begun, response }));
  }
} finally { queue.close(); warm.close(); }
