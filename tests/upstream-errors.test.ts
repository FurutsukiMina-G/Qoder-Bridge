import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {publicUpstreamFailure} from '../src/diagnostics.js';
import {createBridgeServer} from '../src/server.js';
import type {runProbe} from '../src/client.js';

test('explicit SDK daily limit is actionable while unknown details never become public error text',()=>{
  const daily=publicUpstreamFailure(['You have reached the daily usage limit. Please try again later.'],['unknown']);
  assert.equal(daily?.code,'upstream_daily_limit');assert.match(daily!.message,/每日用量上限/);
  assert.equal(publicUpstreamFailure(['unrecognized private payload Cookie=SECRET'],['unknown']),null);
  for(const [category,code]of [['billing_error','upstream_billing_error'],['authentication_failed','upstream_authentication_failed'],['rate_limit','upstream_rate_limit']]){
    const result=publicUpstreamFailure(['Bearer SECRET private payload'],[category!]);
    assert.equal(result?.code,code);assert.ok(!result!.message.includes('SECRET'));
  }
});
test('HTTP and SSE expose daily quota to Harness with zero corrections and no tool dispatch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'qoderbridge-quota-'));let calls=0;
  const fake=(async()=>{calls++;return {response:'',error:'Qoder result: error_during_execution',stage:'inference',
    sdk_errors:['You have reached the daily usage limit. Please try again later.'],api_error_categories:['unknown'],
    result:'error_during_execution',credits_delta:0,model_requests:null};}) as unknown as typeof runProbe;
  const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'test'},{port:0,key:'test',infer:fake,reportDir:dir});
  try{
    const port=(server.address() as AddressInfo).port;
    for(const stream of [false,true]){
      const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}],stream})});
      if(!stream){assert.equal(response.status,502);const body=await response.json();assert.equal(body.error.code,'upstream_daily_limit');assert.match(body.error.message,/daily usage limit/);assert.equal(body.error.decision_recovery.correctionCalls,0);}
      else{const raw=await response.text();assert.match(raw,/upstream_daily_limit/);assert.doesNotMatch(raw,/"tool_calls":|"finish_reason":"stop"|\[DONE\]/);}
    }
    assert.equal(calls,2,'one model invocation per HTTP request; no retries');
    const tasks=(await readFile(join(dir,'tasks.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(tasks.every(t=>t.telemetry.upstream_failure.code==='upstream_daily_limit'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
