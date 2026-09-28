import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rpc } from './dsh-rpc.js';
import { PUBLIC_MODEL } from '../src/server.js';
import { bridgeModel } from '../src/model.js';

const cwd = resolve('.runtime/dsh-native-test', randomUUID());
const tool = process.argv[2] === 'grep' ? 'grep' : 'read';
const selectedModel = process.argv[3] ?? PUBLIC_MODEL;
if (!bridgeModel(selectedModel)) throw new Error('Pass a supported public model ID as the second argument');
await mkdir(cwd, { recursive: true });
const marker = `DSH_NATIVE_TOOL_OK_${randomUUID().slice(0, 8)}`;
await writeFile(resolve(cwd, 'sentinel.txt'), `${marker}\n`, 'utf8');
const created = await rpc('session/create', { request: { cwd } });
const sessionId = created.sessionId as string;
console.log(JSON.stringify({ sessionId, cwd, marker, stage: 'created' }));
await rpc('session/selectModel', { request: { sessionId, provider: 'qoderbridge', model: selectedModel } });
await rpc('session/rename', { request: { sessionId, title: `QoderBridge ${selectedModel.endsWith('-pro') ? 'Pro' : 'Flash'} native ${tool} smoke` } });
await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
  content: [{ type: 'text', text: tool === 'grep'
    ? 'Use your native grep tool to search sentinel.txt for the literal pattern DSH_NATIVE_TOOL_OK_. Return the matching line only after grep returns. Do not use read or guess the contents.'
    : 'Use your native file-reading tool to read sentinel.txt in this workspace. Reply with its exact contents only after the tool returns. Do not guess the contents.' }] } });
console.log(JSON.stringify({ sessionId, stage: 'prompt-accepted' }));
