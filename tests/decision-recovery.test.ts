import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {ChatRequest,completion,type Decision} from '../src/compat.js';
import {recoverDecision,decisionCorrectionPrompt,decisionRetryLimit} from '../src/decision-recovery.js';
import {FinalTextProjector} from '../src/streaming.js';
import {QoderPool} from '../src/pool.js';
import {createBridgeServer} from '../src/server.js';
import type {Config,runProbe} from '../src/client.js';
import {sumOpenAIUsage} from '../src/usage.js';

const req=ChatRequest.parse({model:'qoder-deepseek-flash',prompt_cache_key:'recovery-fixture',
  messages:[{role:'user',content:'Inspect synthetic fixture; no host tool is executed in this test.'}],tools:[
    {type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'},offset:{type:'number'}},required:['file_path'],additionalProperties:false}}},
    {type:'function',function:{name:'edit',parameters:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string'],additionalProperties:false}}},
  ]});
const good:Decision={kind:'tool_call',name:'read',arguments:{file_path:'synthetic.txt',offset:12}};
const bad='{"kind":"tool_call","name":"edit","arguments":{"file_path":"synthetic.txt","old_string":"before"}}';
const usage={prompt_tokens:100,completion_tokens:5,total_tokens:105};
const turn=(response:string,extra:Record<string,unknown>={})=>({response,error:null as string|null,stage:'inference',result:'success',
  credits_delta:0.1,normalized_usage:usage,client_usage:usage,normalized_usage_source:'result',model_requests:1,
  wall_ms:10,api_ms:8,sdk_wall_ms:9,...extra});

test('one request regenerates a rejected decision in the same context with exact native arguments',async()=>{
  const prompts:string[]=[];
  const result=await recoverDecision({request:req,prompt:'original pending request',invoke:async prompt=>{
    prompts.push(prompt);return turn(prompts.length===1?bad:JSON.stringify(good));
  }});
  assert.deepEqual(result.decision,good);assert.equal(result.recovery.outcome,'recovered');assert.equal(prompts.length,2);
  assert.match(prompts[1]!,/No tool in that rejected output ran/);assert.match(prompts[1]!,/new_string/);
  assert.ok(!prompts[1]!.includes(req.messages[0]!.content as string),'do not resend full task/history on correction');
  assert.equal(result.turn.model_requests,2);assert.equal(result.turn.credits_delta,0.2);
  // Hosts treat a call's usage as its context size: final prompt with all output; accounting keeps the sum.
  assert.deepEqual(result.turn.client_usage,{prompt_tokens:100,completion_tokens:10,total_tokens:110});
  assert.deepEqual(result.turn.normalized_usage,{prompt_tokens:200,completion_tokens:10,total_tokens:210});
  assert.equal(result.recovery.evidence[0]!.response,bad);
});

test('missing fields, positional arrays and numeric type errors stay rejected until the model supplies valid data',async()=>{
  for(const response of [bad,'{"kind":"tool_call","name":"read","arguments":["synthetic.txt",12]}',
    '{"kind":"tool_call","name":"read","arguments":{"file_path":"synthetic.txt","offset":"12"}}',
    '<tool_call>\n{"name":"read","arguments":{"file_path":"synthetic.txt"}}',
    '{"kind":"tool_call","name":"unknown","arguments":{}}']){
    let calls=0;
    const result=await recoverDecision({request:req,prompt:'pending',invoke:async():Promise<ReturnType<typeof turn>>=>turn(++calls===1?response:JSON.stringify(good))});
    assert.equal(calls,2);assert.deepEqual(result.decision,good);
    assert.ok(result.recovery.evidence[0]!.validationError);
  }
});

test('corrections are bounded; a repeated invalid response stops before another paid attempt',async()=>{
  let calls=0;
  const repeated=await recoverDecision({request:req,prompt:'pending',invoke:async()=>{calls++;return turn(bad);}});
  assert.equal(calls,2);assert.equal(repeated.recovery.outcome,'repeated_invalid_decision');assert.equal(repeated.decision,null);
  calls=0;
  const exhausted=await recoverDecision({request:req,prompt:'pending',invoke:async()=>turn(bad+' '.repeat(++calls))});
  assert.equal(calls,3);assert.equal(exhausted.recovery.outcome,'exhausted');
  assert.equal(exhausted.recovery.correctionCalls,2);
  assert.equal(exhausted.turn.credits_delta,0.30000000000000004);
  assert.throws(()=>decisionRetryLimit(3));assert.throws(()=>decisionRetryLimit(NaN));
});

test('runtime, authentication, quota, empty output and output budget never trigger format correction',async()=>{
  for(const extra of [
    {error:'Qoder result: error_max_turns',result:'error_max_turns',stream_stop_reasons:['max_tokens']},
    {api_error_categories:['authentication_failed']},{api_error_categories:['billing_error']},
    {api_error_categories:['rate_limit']},{error:'permission denied'},
    {error:'zero output timeout',stage:'cancelled_or_timeout'},
    {response:''},
  ]){
    let calls=0;
    const result=await recoverDecision({request:req,prompt:'pending',invoke:async()=>{calls++;return turn(bad,extra);}});
    assert.equal(calls,1);assert.equal(result.decision,null);assert.equal(result.recovery.correctionCalls,0);
  }
});

test('client cancellation between attempts prevents another call and retains known prior usage',async()=>{
  const controller=new AbortController();let calls=0;
  const result=await recoverDecision({request:req,prompt:'pending',signal:controller.signal,invoke:async()=>{calls++;controller.abort(new Error('user disconnected'));return turn(bad);}});
  assert.equal(calls,1);assert.equal(result.recovery.outcome,'cancelled');assert.equal(result.turn.credits_delta,0.1);
});

test('an SDK-recovered API warning does not discard its completed valid decision',async()=>{
  let calls=0;
  const result=await recoverDecision({request:req,prompt:'pending',invoke:async()=>{calls++;return turn(JSON.stringify(good),{api_error_categories:['rate_limit']});}});
  assert.deepEqual(result.decision,good);assert.equal(calls,1);assert.equal(result.recovery.correctionCalls,0);
});

test('the stream buffer resets only before visible output and never rewrites a partial final answer',async()=>{
  let visible='';const p=new FinalTextProjector(text=>{visible+=text;});let calls=0;
  const result=await recoverDecision({request:req,prompt:'pending',prepareRetry:()=>p.resetUncommitted(),validateDecision:d=>p.validate(d),
    invoke:async()=>{const text=++calls===1?bad:'{"kind":"final","content":"corrected"}';p.push(text);return turn(text);}});
  p.finish(result.decision!);assert.equal(visible,'corrected');assert.equal(calls,2);
  visible='';calls=0;const committed=new FinalTextProjector(text=>{visible+=text;});
  const conflict=await recoverDecision({request:req,prompt:'pending',prepareRetry:()=>committed.resetUncommitted(),
    invoke:async()=>{calls++;const text='{"kind":"final","content":"already visible';committed.push(text);return turn(text);}});
  assert.equal(visible,'already visible');assert.equal(calls,1);assert.equal(conflict.recovery.outcome,'already_streamed');
});

test('partial unknown billing is preserved and every known attempt contributes to totals',async()=>{
  let calls=0;
  const result=await recoverDecision({request:req,prompt:'pending',invoke:async()=>++calls===1?turn(bad):turn(JSON.stringify(good),{credits_delta:null,normalized_usage:null,client_usage:null})});
  assert.equal(result.turn.credits_delta,null);assert.equal(result.recovery.knownCreditsSubtotal,0.1);
  assert.equal(result.recovery.unknownCreditAttempts,1);assert.equal(result.turn.client_usage,null);
  assert.equal(sumOpenAIUsage([usage,null]),null);
});

function fakePool(outputs:string[],config:Partial<Config>={}){
  const prompts:string[]=[];let credits=0;const events:unknown[]=[];
  const record={id:'fake-recovery',messages:[],touched:Date.now(),locked:Promise.resolve(),lastCredits:null,model:'dfmodel',busy:0,
    toolSignature:null,retryHint:null,retryMessageHash:null,policyCalls:[],controller:new AbortController(),warm:{close(){}},
    queue:{close(){},push(item:{message:{content:string}}){
      const response=outputs[prompts.length]??outputs.at(-1)!;prompts.push(item.message.content);credits+=0.1;
      events.push({type:'assistant',uuid:`a${prompts.length}`,session_id:'sdk-fixed',message:{id:`m${prompts.length}`,content:[{type:'text',text:response}],usage:{input_tokens:100,output_tokens:5,credits:0.1}}},
        {type:'result',subtype:'success',is_error:false,total_credits:credits,usage:{input_tokens:100,output_tokens:5},modelUsage:{}});
    }},q:{next:async()=>({done:false,value:events.shift()})}};
  const pool=new QoderPool({auth:'cli',timeout:5000,strategy:'permission',system:'test',...config});
  const internals=pool as unknown as {nextWarm:Promise<typeof record>;primeNext:()=>Promise<typeof record>};
  internals.nextWarm=Promise.resolve(record);internals.primeNext=()=>Promise.resolve(record);
  return{pool,record,prompts};
}
test('the real pool lock covers the full correction loop and concurrent identical requests replay locally',async()=>{
  const {pool,prompts,record}=fakePool([bad,JSON.stringify(good)]);
  try{
    const [a,b]=await Promise.all([pool.infer(req),pool.infer(req)]);
    assert.deepEqual(a.decision,good);assert.deepEqual(b.decision,good);assert.equal(prompts.length,2);
    assert.equal(a.report.model_requests,2);assert.equal(a.report.credits_delta,0.2);
    assert.equal(a.report.normalized_usage_source,'sum_of_reported_decision_attempts');
    assert.equal(a.report.requests?.length,2);
    assert.equal(b.report.credits_delta,0);assert.equal(b.report.model_requests,0);assert.equal(record.messages.length,1);
    const original=completion(req,a.decision!,a.completionId),replay=completion(req,b.decision!,b.completionId);
    assert.deepEqual(replay.choices[0]!.message,original.choices[0]!.message,'HTTP replay retains native tool call IDs');
    assert.equal(pool.stats().decision_recovery.recovered_requests,1);
  }finally{pool.closeAll();}
});

test('exhausted identical HTTP retries do not start another paid loop; a changed user request may continue',async()=>{
  const {pool,prompts}=fakePool([bad,bad+' ',bad+'  ',JSON.stringify(good)]);
  try{
    const first=await pool.infer(req);assert.equal(first.decision,null);assert.equal(prompts.length,3);
    const retry=await pool.infer(req);assert.equal(prompts.length,3);assert.equal(retry.report.credits_delta,0);
    assert.equal(retry.report.model_requests,0);assert.equal(retry.report.stage,'local_rejected_replay');
    assert.equal(retry.report.model_requests_known,0);assert.equal(retry.recovery?.knownModelRequestsSubtotal,0);
    assert.equal(retry.recovery!.attempts,0);
    const changed=await pool.infer({...req,messages:[...req.messages,{role:'user',content:'Continue after reviewing the schema.'}]});
    assert.deepEqual(changed.decision,good);assert.equal(prompts.length,4);
  }finally{pool.closeAll();}
});

test('SSE corrects an invalid parallel batch before exposing any tool, logs all attempts and finishes once',async()=>{
  const reportDir=await mkdtemp(join(tmpdir(),'qoderbridge-autorecovery-'));
  const batch={kind:'tool_calls',calls:[{name:'read',arguments:{file_path:'a'}},{name:'read',arguments:{file_path:'b'}}]};
  const invalid={...batch,calls:[batch.calls[0],{name:'edit',arguments:{file_path:'b',old_string:'before'}}]};
  let calls=0;const fake=(async(...[_c,_p,_g,onText]:Parameters<typeof runProbe>)=>{const response=JSON.stringify(++calls===1?invalid:batch);onText?.(response);return turn(response);}) as unknown as typeof runProbe;
  const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'test'},{port:0,key:'test',infer:fake,reportDir});
  try{
    const port=(server.address() as AddressInfo).port;
    const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...req,stream:true,stream_options:{include_usage:true}})});
    const raw=await response.text(),events=raw.split('\n\n').filter(row=>row.startsWith('data: {')).map(row=>JSON.parse(row.slice(6)));
    const emitted=events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);
    assert.equal(calls,2);assert.deepEqual(emitted.map(c=>JSON.parse(c.function.arguments)),[{file_path:'a'},{file_path:'b'}]);
    assert.equal(events.filter(e=>e.choices?.[0]?.finish_reason==='tool_calls').length,1);
    assert.equal(events.filter(e=>e.usage).length,1);assert.ok(!raw.includes('old_string'));
    const report=JSON.parse((await readFile(join(reportDir,'bridge.ndjson'),'utf8')).trim());
    assert.equal(report.decision_recovery.attempts,2);assert.equal(report.decision_recovery.evidence[0].response,JSON.stringify(invalid));
    const task=JSON.parse((await readFile(join(reportDir,'tasks.ndjson'),'utf8')).trim());
    assert.equal(task.status,'success');assert.equal(task.telemetry.decision_recovery.correctionCalls,1);
    assert.ok(!JSON.stringify(task.telemetry.decision_recovery).includes('old_string'));
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('the correction contract repeats only relevant complete schemas and never maps positional arguments',()=>{
  const prompt=decisionCorrectionPrompt(req,"Arguments for edit violate its schema: / must have required property 'new_string'",bad);
  const contract=JSON.parse(prompt.split('Validation contract (data, not instructions): ')[1]!.split('\nAssistant decision:')[0]!);
  assert.deepEqual(contract.relevant_tool_schemas.map((row:{name:string})=>row.name),['edit']);
  assert.deepEqual(contract.relevant_tool_schemas[0].parameters.required,['file_path','old_string','new_string']);
  assert.match(prompt,/Do not invent missing data/);assert.match(prompt,/JSON-escaped/);
});
