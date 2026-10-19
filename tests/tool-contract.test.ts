import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import type {runProbe} from '../src/client.js';
import {ChatRequest,parseDecision} from '../src/compat.js';
import {assertToolContract,toolValidator} from '../src/tool-contract.js';
import {createBridgeServer} from '../src/server.js';

test('malformed/ambiguous client tool contracts fail before streaming or any paid inference',async()=>{
  let calls=0;
  const fake=(async()=>{calls++;throw new Error('must not invoke model');}) as unknown as typeof runProbe;
  const reportDir=await mkdtemp(join(tmpdir(),'qoderbridge-contract-'));
  const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'test'},{port:0,key:'test',infer:fake,reportDir});
  const tool={type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}}};
  const base={model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}],stream:true};
  try{
    for(const invalid of [{tools:[tool,tool]},{tools:[{...tool,function:{...tool.function,parameters:{type:'impossible'}}}]},
      {tools:[{...tool,function:{...tool.function,parameters:false}}]},
      {tools:[tool],tool_choice:{type:'function',function:{name:'missing'}}},{tool_choice:'required'}]){
      const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...base,...invalid})});
      assert.equal(response.status,400);assert.match(response.headers.get('content-type')!,/application\/json/);
      assert.equal((await response.json()).error.type,'invalid_request_error');
    }
    assert.equal(calls,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('schema caching reuses equivalent catalogs while independent $id definitions cannot contaminate another client',()=>{
  const a={$id:'shared-tool',type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false};
  const b={$id:'shared-tool',type:'object',properties:{offset:{type:'number'}},required:['offset'],additionalProperties:false};
  assert.equal(toolValidator(a),toolValidator(JSON.parse(JSON.stringify(a))));
  assert.equal(toolValidator(a)({path:'fixture'}),true);assert.equal(toolValidator(b)({path:'fixture'}),false);
  const request=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}],tools:[{type:'function',function:{name:'read',parameters:a}}]});
  assertToolContract(request);
  assert.deepEqual(parseDecision('{"kind":"tool_call","name":"read","arguments":{"path":"fixture"}}',request),{kind:'tool_call',name:'read',arguments:{path:'fixture'}});
});
