import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ModelInfo } from '@qodercn-ai/qodercn-agent-sdk';
import { bridgeModel, selectModel, PRO_PUBLIC_MODEL, DEFAULT_PUBLIC_MODEL } from '../src/model.js';
import { createBridgeServer } from '../src/server.js';
import type { Config, runProbe } from '../src/client.js';

test('Pro selection validates its own catalog entry and cannot fall back to Flash', () => {
  const pro = { value: 'dmodel', displayName: 'DeepSeek-V4-Pro', description: '', isEnabled: true,
    context_config: { '1M': { token_count: 1_000_000 } },
    thinking_config: { enabled: { efforts: { high: {}, max: {} } } },
  } as ModelInfo;
  const flash = { ...pro, value: 'dfmodel', displayName: 'DeepSeek-Flash' };
  const config = { model: bridgeModel(PRO_PUBLIC_MODEL)!.runtimeId, context: 1_000_000, reasoning: 'max' };
  assert.equal(selectModel([flash, pro], config).model, 'dmodel');
  assert.throws(() => selectModel([flash], config), /found 0/);
  assert.throws(() => selectModel([flash, { ...pro, isEnabled: false }], config), /found 0/);
  assert.throws(() => selectModel([pro], { ...config, reasoning: 'low' }), /Unsupported reasoning/);
});
test('one endpoint advertises both models and routes Pro JSON/SSE to dmodel without relabeling Flash', async () => {
  const selected: string[] = [];
  const fake = (async (config: Config) => {
    selected.push(config.model!);
    return { response: JSON.stringify({ kind: 'final', content: config.model }), error: null, stage: 'inference' };
  }) as unknown as typeof runProbe;
  await mkdir('.runtime', { recursive: true });
  const server = await createBridgeServer({ auth: 'cli', timeout: 5000, strategy: 'permission', system: 'test' },
    { port: 0, key: 'test', infer: fake, reportDir: await mkdtemp(resolve('.runtime/pro-tests-')) });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
  const send = (model: string, stream = false) => fetch(`${root}/v1/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify({ model, stream,
      prompt_cache_key: 'same-harness-session', messages: [{ role: 'user', content: 'fixture' }] }),
  });
  try {
    const models = await fetch(`${root}/v1/models`, { headers }).then(response => response.json());
    assert.deepEqual(models.data.map((model: { id: string }) => model.id), [DEFAULT_PUBLIC_MODEL, PRO_PUBLIC_MODEL]);
    const pro = await send(PRO_PUBLIC_MODEL).then(response => response.json());
    assert.equal(pro.model, PRO_PUBLIC_MODEL);
    assert.equal(pro.choices[0].message.content, 'dmodel');
    const flash = await send(DEFAULT_PUBLIC_MODEL).then(response => response.json());
    assert.equal(flash.choices[0].message.content, 'dfmodel');
    const events = (await (await send(PRO_PUBLIC_MODEL, true)).text()).split('\n\n')
      .filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.ok(events.every(event => event.model === PRO_PUBLIC_MODEL));
    assert.ok(events.some(event => event.choices[0].delta.content === 'dmodel'));
    assert.equal((await send('deepseek-pro-unknown')).status, 400);
    assert.deepEqual(selected, ['dmodel', 'dfmodel', 'dmodel']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
