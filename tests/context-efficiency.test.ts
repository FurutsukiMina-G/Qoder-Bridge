import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatRequest,conversationPrompt,type Decision} from '../src/compat.js';
import {hasConversationPrefix,routeConversation,prefixIssue} from '../src/routing.js';
import {QoderPool} from '../src/pool.js';
const base={model:'qoder-deepseek-flash',prompt_cache_key:'one-task'};
test('only message data actually presented to the model determines a history prefix',()=>{
  const previous=ChatRequest.parse({...base,messages:[{role:'user',content:'same',local_id:'old'},{role:'assistant',content:null,reasoning_content:'not sent in conversationPrompt'}]}).messages;
  const next=ChatRequest.parse({...base,messages:[{role:'user',content:[{type:'text',text:'same'}],local_id:'new'},{role:'assistant',content:'',reasoning_content:'transport changed'},{role:'user',content:'next'}]});
  assert.equal(hasConversationPrefix(previous,next.messages),true);
  assert.equal(routeConversation(next,new Map([['q',{messages:previous}]]),new Map([['one-task','q']]),new Map()),'q');
  for(const changed of [{role:'user',content:'changed'},{role:'system',content:'same'},{role:'user',content:'same',name:'different'}])
    assert.equal(hasConversationPrefix(previous,ChatRequest.parse({...base,messages:[changed,...next.messages.slice(1)]}).messages),false);
});
test('history rewrite diagnostics expose only counts, roles and hashes',()=>{
  const a=ChatRequest.parse({...base,messages:[{role:'user',content:'PRIVATE_A'}]}).messages;
  const b=ChatRequest.parse({...base,messages:[{role:'user',content:'PRIVATE_B'}]}).messages;
  const report=prefixIssue(a,b);assert.equal(report?.first_changed_index,0);assert.equal(report?.reason,'history_rewritten');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);assert.equal(prefixIssue(a,a),null);
});
test('pool continues one model session for metadata-only changes and deduplicates only its own exact last decision',async()=>{
  const args={file_path:'fixture.txt',content:'Synthetic content'.repeat(1200)};
  const outputs=[JSON.stringify({kind:'tool_call',name:'write',arguments:args}),'{"kind":"final","content":"已完成。"}'];
  const prompts:string[]=[];let phase=0,turn=0;
  const record={id:'mock-session',q:{next:async()=>{
    if(phase++%2===0)return {done:false,value:{type:'assistant',uuid:`a${turn}`,message:{id:`m${turn}`,model:'dfmodel',content:[{type:'text',text:outputs[turn]}],usage:{input_tokens:0,output_tokens:0,credits:0.1}}}};
    turn++;return{done:false,value:{type:'result',subtype:'success',is_error:false,total_credits:turn*0.1,modelUsage:{},usage:{},duration_ms:10,duration_api_ms:8}};
  }},queue:{push:(item:{message:{content:string}})=>prompts.push(item.message.content),close(){}},messages:[],touched:Date.now(),locked:Promise.resolve(),lastCredits:null,model:'dfmodel',busy:0,toolSignature:null,retryHint:null,policyCalls:[],warm:{close(){}},controller:new AbortController()};
  const pool=new QoderPool({auth:'cli',timeout:30000,strategy:'permission',system:'fixture'});
  const injected=pool as unknown as {nextWarm:Promise<typeof record>;primeNext:()=>Promise<typeof record>};injected.nextWarm=Promise.resolve(record);injected.primeNext=()=>Promise.resolve(record);
  try{
    const first=ChatRequest.parse({...base,messages:[{role:'user',content:'Write fixture',transport_id:'one'}],tools:[{type:'function',function:{name:'write',parameters:{type:'object'}}}]});
    await pool.infer(first);
    const next=ChatRequest.parse({...first,messages:[{...first.messages[0],transport_id:'two'},{role:'assistant',content:null,tool_calls:[{id:'real-host-id',type:'function',function:{name:'write',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:'real-host-id',content:'Actual verified result'}]});
    const r=await pool.infer(next);assert.equal(r.report.history_mode,'delta');assert.equal(r.report.reused_session,true);
    assert.ok('prompt_optimization' in r.report);assert.ok(r.report.prompt_optimization!.echo_characters_avoided>15000);assert.equal(r.report.sent_message_count,2);
    assert.match(prompts[1]!,/real-host-id/);assert.match(prompts[1]!,/Actual verified result/);assert.doesNotMatch(prompts[1]!,/Synthetic content/);
    const replay=await pool.infer(ChatRequest.parse({...next,messages:[{...next.messages[0],transport_id:'three'},...next.messages.slice(1)]}));
    assert.equal(replay.report.local_response_replay,true);assert.equal(prompts.length,2);
    assert.equal(replay.completionId,r.completionId);
  }finally{pool.closeAll()}
});
test('an exact prior tool decision echo retains host IDs and all results without reinjecting large arguments',()=>{
  const args={file_path:'fixture.txt',content:'合成测试文本'.repeat(2000)};
  const prior:Decision={kind:'tool_call',name:'write',arguments:args};
  const request=ChatRequest.parse({...base,messages:[{role:'assistant',content:null,tool_calls:[{id:'host-id',type:'function',function:{name:'write',arguments:JSON.stringify(args)}}]},{role:'tool',tool_call_id:'host-id',content:'actual tool failure: denied'}]});
  const compact=conversationPrompt(request,{historyMode:'delta',omitUnchangedTools:true,priorDecision:prior});
  assert.ok(compact.length<1000);assert.match(compact,/host-id/);assert.match(compact,/actual tool failure: denied/);assert.match(compact,/arguments_sha256/);assert.doesNotMatch(compact,/合成测试文本/);
  const full=conversationPrompt(request,{historyMode:'full',priorDecision:prior});assert.match(full,/合成测试文本/);
  const changed=ChatRequest.parse({...request,messages:[{...request.messages[0],tool_calls:[{id:'host-id',type:'function',function:{name:'write',arguments:JSON.stringify({...args,content:args.content+'changed'})}}]},request.messages[1]]});
  assert.match(conversationPrompt(changed,{historyMode:'delta',priorDecision:prior}),/合成测试文本/);
  const malformedEcho=ChatRequest.parse({...request,messages:[{...request.messages[0],tool_calls:[null]},request.messages[1]]});
  assert.match(conversationPrompt(malformedEcho,{historyMode:'delta',priorDecision:prior}),/"tool_calls":\[null\]/);
});
test('delta prompts use the established contract without dropping changed tools or tool_choice',()=>{
  const request=ChatRequest.parse({...base,messages:[{role:'tool',tool_call_id:'id',content:'result'}],tool_choice:'required',tools:[{type:'function',function:{name:'read',parameters:{type:'object',required:['file_path'],properties:{file_path:{type:'string'}}}}}]});
  const prompt=conversationPrompt(request,{historyMode:'delta'});assert.match(prompt,/"required"/);assert.match(prompt,/"file_path"/);assert.match(prompt,/exactly one JSON decision/);
  assert.ok(prompt.length<conversationPrompt(request).length/2);
});
