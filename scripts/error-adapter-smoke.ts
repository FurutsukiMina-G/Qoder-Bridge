/** Offline installed-DSH transport contract. No SDK inference, application, GUI or DSH session is started. */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createBridgeServer } from '../src/server.js';
import type { runProbe } from '../src/client.js';

const shellRoot = resolve(process.argv[2] ?? '.runtime/dsh-current-shell');
const reportPath = resolve(process.argv[3] ?? 'reports/error-adapter-smoke.json');
const packageRoot = resolve(shellRoot, 'dsh/node_modules/@earendil-works/pi-ai');
const pluginRoot = resolve(shellRoot, 'dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai');
const adapterPath = resolve(packageRoot, 'dist/api/openai-completions.js');
const adapterVersion = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')).version;
const pluginVersion = JSON.parse(await readFile(resolve(pluginRoot, 'package.json'), 'utf8')).version;
const plugin = await readFile(resolve(pluginRoot, 'lib/index.js'), 'utf8');
assert.ok(plugin.includes('message.errorMessage ?? "pi-ai stream error"'), 'Installed DSH must preserve the adapter error text');
const { stream } = await import(pathToFileURL(adapterPath).href);
const { normalizeContext } = await import(pathToFileURL(resolve(packageRoot, 'dist/utils/transcript.js')).href);
await mkdir('.runtime', { recursive: true });
const root = await mkdtemp(resolve('.runtime/error-adapter-fixtures-'));
const checks = [];
for (const [name, origin, code] of [
  ['daily-text','账号','upstream_daily_limit'], ['free-user','账号','upstream_free_user_limit'],
  ['service','上游服务/SDK','upstream_service_error'], ['malformed','模型输出/协议','model_decision_recovery_exhausted'],
  ['local-report','Bridge','bridge_internal_error'], ['bridge-key','DSH/客户端请求','bridge_authentication_failed'],
  ['client-model','DSH/客户端请求','invalid_request_error'], ['unknown','来源未确定','unclassified_failure'],
] as const) {
  const folder = resolve(root,name); await mkdir(folder);
  const reportDir = name === 'local-report' ? resolve(folder,'file') : folder;
  if (name === 'local-report') await writeFile(reportDir,'fixture');
  let calls = 0;
  const infer = (async () => {
    calls++;
    if (name === 'unknown') throw new Error('PRIVATE_FIXTURE_PAYLOAD');
    if (name === 'malformed') return { response:'{',error:null,stage:'inference' };
    if (['local-report','bridge-key','client-model'].includes(name))
      return { response:'{"kind":"final","content":"OK"}',error:null,stage:'inference' };
    return { response:'',error:'Qoder result: error_during_execution',result:'error_during_execution',stage:'inference',
      sdk_error_code:name==='free-user'?115:name==='service'?10500:null,
      sdk_errors:name==='daily-text'?['You have reached the daily usage limit. Please try again later.']:['PRIVATE_FIXTURE_PAYLOAD'] };
  }) as unknown as typeof runProbe;
  const server = await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'fixture'},
    {port:0,key:'test',reportDir,infer});
  try {
    const model = { id:name==='client-model'?'unsupported-fixture-model':'qoder-deepseek-flash', name:'fixture',
      api:'openai-completions',provider:'qoderbridge',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      reasoning:true,input:['text'],contextWindow:1_000_000,maxTokens:1000,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
      compat:{supportsUsageInStreaming:true,supportsDeveloperRole:false} };
    const events:any[]=[];
    for await (const event of stream(model,normalizeContext({messages:[{role:'user',content:'synthetic error fixture',timestamp:Date.now()}]}),
      {apiKey:name==='bridge-key'?'wrong':'test'})) events.push(event);
    const terminal=events.find(event=>event.type==='error');
    assert.ok(terminal,`${name}: expected adapter error`); assert.ok(!events.some(event=>event.type==='done'));
    const message=terminal.error.errorMessage as string;
    assert.ok(message.includes(`[${origin}]`),`${name}: missing source`);
    assert.ok(message.includes(`错误码：${code}`),`${name}: missing code`);
    const id=/请求ID：([a-f0-9-]{36})/.exec(message)?.[1]; assert.ok(id,`${name}: missing request ID`);
    assert.doesNotMatch(message,/PRIVATE_FIXTURE_PAYLOAD/);
    if(name==='daily-text') assert.doesNotMatch(message,/SDK错误码/,'do not infer numeric 110 from text');
    if(name==='free-user') assert.ok(message.includes('SDK错误码：115'));
    assert.ok(!events.some(event=>['toolcall_start','toolcall_end'].includes(event.type)));
    assert.equal(calls,['bridge-key','client-model'].includes(name)?0:name==='malformed'?2:1);
    checks.push({name,origin,code,terminal:'error',requestId:id,calls,eventTypes:events.map(event=>event.type),message});
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
await mkdir(dirname(reportPath),{recursive:true});
await writeFile(reportPath,JSON.stringify({checkedAt:new Date().toISOString(),adapterPath,adapterVersion,pluginVersion,
  mode:'offline injected provider results; installed DSH adapter, no application tests or model requests',
  dshPreservesErrorMessage:true,checks},null,2));
console.log(JSON.stringify({passed:checks.length,adapterVersion,pluginVersion,reportPath}));
