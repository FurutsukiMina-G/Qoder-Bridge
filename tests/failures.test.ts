import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { SDKMessage } from '@qodercn-ai/qodercn-agent-sdk';
import { bridgeFailure, sdkExceptionDetails, type FailureInput } from '../src/failures.js';
import { Telemetry } from '../src/telemetry.js';
import { createBridgeServer } from '../src/server.js';
import type { runProbe } from '../src/client.js';
import type { RecoveryTrace } from '../src/decision-recovery.js';

const input: FailureInput = { requestId: 'fixture-id', phase: 'upstream', accepted: true };
const recovery = (outcome: RecoveryTrace['outcome']) => ({ outcome } as RecoveryTrace);
const quotaText = ['You have reached the daily usage limit. Please try again later.'];
test('SDK result codes distinguish account limits and override ambiguous quota text without inventing a code', () => {
  for (const [code, expected] of [[105,'upstream_authentication_failed'],[110,'upstream_daily_limit'],
    [113,'upstream_quota_exhausted'],[114,'upstream_free_trial_limit'],[115,'upstream_free_user_limit'],
    [116,'upstream_team_admin_credits'],[117,'upstream_team_member_credits'],[118,'upstream_personal_credits'],
    [119,'upstream_model_free_quota'],[122,'upstream_billing_group_credits']] as const) {
    const error = bridgeFailure({ ...input, turn: { sdk_error_code: code, sdk_errors: quotaText } });
    assert.equal(error.code, expected); assert.equal(error.origin, 'account');
    assert.equal(error.sdk_error_code, code); assert.match(error.message, /^\[账号\]/);
    assert.ok(error.message.includes(`SDK错误码：${code}`)); assert.match(error.message, /fixture-id/);
  }
  const textOnly = bridgeFailure({ ...input, turn: { sdk_errors: quotaText } });
  assert.equal(textOnly.code, 'upstream_daily_limit'); assert.equal(textOnly.sdk_error_code, null);
  assert.doesNotMatch(textOnly.message, /SDK错误码|110/);
  const unknown = bridgeFailure({ ...input, turn: { sdk_error_code: 'FUTURE_123' } });
  assert.equal(unknown.code, 'upstream_unknown_error_code'); assert.equal(unknown.sdk_error_code, 'FUTURE_123');
});
test('local Bridge guard, model protocol, client request, upstream service and unknown errors keep distinct evidence', () => {
  const cases: Array<[Partial<FailureInput>, string, string]> = [
    [{ accepted:false, cause:new Error('private Cookie=SECRET') },'dsh_request','invalid_request_error'],
    [{ early:'authentication',accepted:false },'dsh_request','bridge_authentication_failed'],
    [{ phase:'reporting',cause:new Error('disk private SECRET') },'bridge','bridge_internal_error'],
    [{ abort:'deadline' },'bridge','bridge_request_timeout'],
    [{ abort:'client_disconnect' },'connection','client_disconnected'],
    [{ recovery:recovery('reasoning_budget'),turn:{result:'error_max_turns'} },'bridge','qoder_reasoning_budget'],
    [{ recovery:recovery('output_budget'),turn:{sdk_error_code:47902,result:'error_max_turns'} },'upstream','qoder_output_budget'],
    [{ recovery:recovery('exhausted') },'model_output','model_decision_recovery_exhausted'],
    [{ recovery:recovery('stream_conflict') },'bridge','bridge_stream_conflict'],
    [{ turn:{sdk_error_code:10500} },'upstream','upstream_service_error'],
    [{ turn:{sdk_error_code:80411} },'dsh_request','upstream_input_too_long'],
    [{ turn:{sdk_error_code:500} },'upstream','upstream_request_failed'],
    [{ cause:new Error('private Cookie=SECRET') },'unknown','unclassified_failure'],
  ];
  for (const [fixture,origin,code] of cases) {
    const error = bridgeFailure({ ...input, ...fixture });
    assert.equal(error.origin,origin); assert.equal(error.code,code);
    assert.doesNotMatch(JSON.stringify(error),/SECRET|Cookie=/); assert.equal(error.automatic_retry,false);
    assert.match(error.message,/建议：.+\n错误码：.+请求ID：fixture-id/);
  }
  assert.equal(bridgeFailure({...input,recovery:recovery('output_budget'),turn:{sdk_error_code:115}}).origin,'account');
  assert.equal(bridgeFailure({...input,recovery:recovery('output_budget'),turn:{sdk_error_code:10500}}).code,'upstream_service_error');
});
test('SDK exception and process exit namespaces stay separate and terminal metadata survives telemetry', () => {
  const exception = Object.assign(new Error('SECRET'), {name:'QoderCliProcessError',code:'QODER_CLI_PROCESS_ERROR',exitCode:41});
  assert.equal(bridgeFailure({...input,cause:exception}).code,'upstream_authentication_failed');
  const wrongNamespace = bridgeFailure({...input,cause:Object.assign(new Error(),{exitCode:110})});
  assert.equal(wrongNamespace.sdk_error_code,null); assert.equal(wrongNamespace.origin,'unknown');
  assert.equal(bridgeFailure({...input,cause:Object.assign(new Error(),{result:{error_code:115}})}).code,'upstream_free_user_limit');
  const t = new Telemetry(); t.captureException(exception);
  t.observe({type:'result',subtype:'error_during_execution',is_error:true,errors:['generic'],error_code:'118'} as unknown as SDKMessage);
  assert.equal(t.snapshot().sdk_error_code,'118'); assert.equal(t.snapshot().sdk_exception?.exit_code,41);
  assert.equal(sdkExceptionDetails({result:{error_code:'Cookie=SECRET'}}).result_error_code,null);
});

test('HTTP and SSE expose the same source, safe text and request ID, with no success terminal or retry', async () => {
  for (const [sdkCode,origin] of [[115,'account'],[10500,'upstream'],[80411,'dsh_request'],['FUTURE_123','upstream']] as const) {
    const dir = await mkdtemp(join(tmpdir(),'qoderbridge-errors-')); let calls = 0;
    const fake = (async () => { calls++; return { response:'',error:'upstream failed SECRET',stage:'inference',
      result:'error_during_execution',sdk_error_code:sdkCode,sdk_errors:['Cookie=SECRET'],api_error_categories:['unknown'] }; }) as unknown as typeof runProbe;
    const server = await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'fixture'},
      {port:0,key:'test',infer:fake,reportDir:dir});
    try {
      for (const stream of [false,true]) {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, {
          method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},
          body:JSON.stringify({model:'qoder-deepseek-flash',stream,messages:[{role:'user',content:'synthetic'}]}) });
        const raw = await response.text();
        const error = stream ? JSON.parse(raw.split('\n').find(line=>line.startsWith('data: {"error":'))!.slice(6)).error : JSON.parse(raw).error;
        assert.equal(response.status,stream?200:502); assert.equal(error.origin,origin);
        assert.equal(error.sdk_error_code,sdkCode); assert.equal(error.request_id,response.headers.get('x-qoderbridge-request-id'));
        assert.ok(error.message.includes(error.request_id)); assert.match(error.message,/^\[/);
        assert.equal(response.headers.get('x-should-retry'),'false');
        assert.equal(error.decision_recovery.correctionCalls,0);
        assert.doesNotMatch(raw,/SECRET|Cookie=|\[DONE\]|"finish_reason":"stop"|"tool_calls":/);
      }
      assert.equal(calls,2,'no paid/retry probe: one injected SDK result per request');
      const failures = (await readFile(join(dir,'errors.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      const tasks = (await readFile(join(dir,'tasks.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(failures.length,2); assert.equal(tasks.length,2);
      assert.ok(tasks.every(t=>t.telemetry.failure.origin===origin && t.telemetry.sdk_error_code===sdkCode));
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }
});
test('preflight errors have IDs and identify the local Bridge key rather than upstream authentication', async () => {
  let calls=0; const dir=await mkdtemp(join(tmpdir(),'qoderbridge-preflight-errors-'));
  const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'fixture'},
    {port:0,key:'test',reportDir:dir,infer:(async()=>{calls++;throw new Error('unreachable');}) as unknown as typeof runProbe});
  try {
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [path,key,body,status,code] of [
      ['/v1/chat/completions','wrong','{}',401,'bridge_authentication_failed'],
      ['/wrong','test','{}',404,'bridge_endpoint_not_found'],
      ['/v1/chat/completions','test','{"private":"SECRET",',400,'invalid_request_error'],
    ] as const) {
      const response=await fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${key}`},body});
      const error=(await response.json()).error;
      assert.equal(response.status,status); assert.equal(error.code,code); assert.equal(error.origin,'dsh_request');
      assert.equal(error.request_id,response.headers.get('x-qoderbridge-request-id')); assert.doesNotMatch(error.message,/SECRET/);
    }
    assert.equal(calls,0);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('client disconnect is logged without blaming DSH, while the Bridge deadline is returned in SSE', async () => {
  const dir=await mkdtemp(join(tmpdir(),'qoderbridge-disconnect-'));
  const fake=(async()=>{await new Promise(resolve=>setTimeout(resolve,100));return {response:'',error:'aborted',stage:'inference'};}) as unknown as typeof runProbe;
  const server=await createBridgeServer({auth:'cli',timeout:50,strategy:'permission',system:'fixture'},
    {port:0,key:'test',reportDir:dir,infer:fake});
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const init={method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},
    body:JSON.stringify({model:'qoder-deepseek-flash',stream:true,messages:[{role:'user',content:'fixture'}]})};
  try {
    const first=await fetch(url,init); const reader=first.body!.getReader(); await reader.read(); await reader.cancel();
    await new Promise(resolve=>setTimeout(resolve,150));
    const rows=(await readFile(join(dir,'errors.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
    assert.equal(rows[0].error.code,'client_disconnected'); assert.equal(rows[0].error.origin,'connection');
    const response=await fetch(url,init); const raw=await response.text();
    assert.match(raw,/bridge_request_timeout/); assert.match(raw,/Bridge/); assert.doesNotMatch(raw,/\[DONE\]/);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('a local report write failure is identified as Bridge rather than model output', async () => {
  const dir=await mkdtemp(join(tmpdir(),'qoderbridge-report-failure-')); const file=join(dir,'not-a-directory');
  await writeFile(file,'fixture');
  const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'fixture'},
    {port:0,key:'test',reportDir:file,infer:(async()=>({response:'{"kind":"final","content":"OK"}',error:null,stage:'inference'})) as unknown as typeof runProbe});
  try {
    const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,{
      method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}]})});
    const error=(await response.json()).error; assert.equal(error.origin,'bridge'); assert.equal(error.code,'bridge_internal_error');
    assert.equal(error.phase,'reporting');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
