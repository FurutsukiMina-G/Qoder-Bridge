import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatRequest,parseDecision} from '../src/compat.js';
import {FinalTextProjector} from '../src/streaming.js';
import {recoverDecision} from '../src/decision-recovery.js';
const request=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'检查配置后用中文回答'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}}]});
const malformed='<system_call> <name="read">{"file_path":"fixture.js"}</name> <name="name="grep">{"pattern":"fixture"}</name></name> <name="new_string">not a complete edit</name></system_call>';
test('observed system_call/name corruption is rejected atomically instead of exposed as final prose',()=>{
  for(const raw of [malformed,JSON.stringify({kind:'final',content:malformed}),'```xml\n'+malformed+'\n```'])
    assert.throws(()=>parseDecision(raw,request));
  assert.throws(()=>parseDecision('<system_call><name="read">{"file_path":"fixture"}</name>\n'+
    '{"kind":"final","content":"embedded literal must not hide rejected tool intent"}\n</system_call>',request));
  assert.deepEqual(parseDecision(JSON.stringify({kind:'tool_call',name:'read',arguments:{file_path:'<system_call>literal.txt'}}),request),{kind:'tool_call',name:'read',arguments:{file_path:'<system_call>literal.txt'}});
  const explanation='这是工具协议示例，请勿手工执行：\n```xml\n<system_call>example</system_call>\n```';
  assert.equal(parseDecision(JSON.stringify({kind:'final',content:explanation}),request).kind,'final');
});
test('split final-content protocol is never streamed even one character at a time',()=>{
  let emitted='';const p=new FinalTextProjector(s=>emitted+=s);
  for(const c of JSON.stringify({kind:'final',content:malformed}))p.push(c);
  assert.equal(emitted,'');assert.throws(()=>p.finish({kind:'final',content:malformed}));
  assert.equal(p.resetUncommitted(),true);
  p.push('{"kind":"final","content":"已检查，请确认目录。"}');p.finish({kind:'final',content:'已检查，请确认目录。'});
  assert.equal(emitted,'已检查，请确认目录。');
});
test('raw protocol leak uses the existing bounded correction, without dispatching a partial batch',async()=>{
  let calls=0;const r=await recoverDecision({request,prompt:'fixture',invoke:async(prompt)=>{
    calls++;if(calls===2){assert.match(prompt,/No tool.*ran/);assert.match(prompt,/"name":"read"/)}
    return{response:calls===1?malformed:'{"kind":"final","content":"读取前请确认文件路径。"}',error:null,stage:'inference'};
  }});
  assert.equal(calls,2);assert.equal(r.recovery.outcome,'recovered');assert.deepEqual(r.decision,{kind:'final',content:'读取前请确认文件路径。'});
});
