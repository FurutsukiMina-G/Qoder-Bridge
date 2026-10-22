import test from 'node:test';
import assert from 'node:assert/strict';
import type {SDKMessage} from '@qodercn-ai/qodercn-agent-sdk';
import {Telemetry} from '../src/telemetry.js';
import {requestAccounting} from '../src/request-metrics.js';
import {recoverDecision,type RecoveryTurn} from '../src/decision-recovery.js';
import {ChatRequest} from '../src/compat.js';
const emit=(t:Telemetry,value:unknown)=>t.observe(value as SDKMessage);
const start=(t:Telemetry,id?:string)=>emit(t,{type:'stream_event',event:{type:'message_start',message:{id,usage:{input_tokens:0,output_tokens:0}}}});
const assistant=(t:Telemetry,request?:string,message?:string)=>emit(t,{type:'assistant',uuid:'fixture',request_id:request,message:{id:message,content:[{type:'text',text:'fixture'}],usage:{input_tokens:1,output_tokens:1}}});
test('streamed and assistant-only retry responses are both counted by identity',()=>{
  const t=new Telemetry();start(t,'partial');emit(t,{type:'system',subtype:'api_retry',attempt:1,max_retries:3,retry_delay_ms:0,error_status:503,error:'server_error'});
  assistant(t,'retry-request','completed');
  const result=t.snapshot();assert.equal(result.model_requests,2);assert.equal(result.model_requests_known,2);
  assert.match(result.model_request_count_source,/linked/);
});
test('overlapping response IDs deduplicate while disjoint stream and assistant responses are retained',()=>{
  const t=new Telemetry();start(t,'common');start(t,'stream-only');assistant(t,'common-request','common');assistant(t,'assistant-request','assistant-only');
  assert.equal(t.snapshot().model_requests,3);
  const one=new Telemetry();start(one,'one');assistant(one,'request-one','one');start(one,'one');assistant(one,'request-one','one');
  assistant(one,'request-one','another-fragment');start(one,'another-fragment');assert.equal(one.snapshot().model_requests,1);
});
test('unidentified streams retain known response subtotals but do not fabricate an exact count',()=>{
  const t=new Telemetry();start(t);assistant(t,'identified','identified-message');
  const report=t.snapshot();assert.equal(report.model_requests,null);assert.equal(report.model_requests_known,1);
  assert.equal(report.unidentified_response_events,1);assert.match(report.model_request_count_source,/partial/);
  const accounting=requestAccounting([{telemetry:report}]);assert.equal(accounting.upstreamModelRequestsKnown,1);assert.equal(accounting.upstreamModelRequestCountUnknown,1);
  const noStart=new Telemetry();emit(noStart,{type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'fixture'}}});
  assert.equal(noStart.snapshot().model_requests,null);assert.equal(noStart.snapshot().unidentified_response_events,1);
});
test('SDK retry metadata and API-error assistant notices do not invent a model response',()=>{
  const t=new Telemetry();emit(t,{type:'system',subtype:'api_retry',attempt:1,max_retries:3,retry_delay_ms:0,error_status:503,error:'server_error'});
  emit(t,{type:'assistant',isApiErrorMessage:true,error:'server_error'});assert.equal(t.snapshot().model_requests,null);assert.equal(t.snapshot().model_requests_known,0);
  assistant(t);assert.equal(t.snapshot().model_requests,null);assert.equal(t.snapshot().unidentified_response_events,1);
});
test('missing cross-source links and conflicting IDs remain unknown without merging distinct explicit request IDs',()=>{
  const unknown=new Telemetry();start(unknown,'stream');assistant(unknown,'request-only');
  assert.equal(unknown.snapshot().model_requests,null);assert.equal(unknown.snapshot().model_requests_known,1);
  assistant(unknown,'request-only','stream');assert.equal(unknown.snapshot().model_requests,1);
  const conflict=new Telemetry();assistant(conflict,'request-one','reused-message');assistant(conflict,'request-two','reused-message');
  assert.equal(conflict.snapshot().model_requests,null);assert.equal(conflict.snapshot().model_requests_known,2);
});
test('recovery accounting preserves known calls when one attempt has an incomplete response count',async()=>{
  let calls=0;const request=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}]});
  const r=await recoverDecision({request,prompt:'fixture',invoke:async():Promise<RecoveryTurn>=>++calls===1?
    {response:'{',error:null,stage:'inference',model_requests:1,model_requests_known:1,unidentified_response_events:0}:
    {response:'{"kind":"final","content":"ok"}',error:null,stage:'inference',model_requests:null,model_requests_known:1,unidentified_response_events:1}});
  assert.equal(calls,2);assert.equal(r.turn.model_requests,null);assert.equal(r.turn.model_requests_known,2);assert.equal(r.turn.unidentified_response_events,1);
  assert.equal(r.recovery.knownModelRequestsSubtotal,2);assert.equal(r.recovery.unknownModelRequestAttempts,1);
  assert.equal(requestAccounting([{telemetry:r.turn}]).upstreamModelRequestsKnown,2);
});
