import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {AddressInfo} from 'node:net';
import {ChatRequest,parseDecision,type DecisionRepair} from '../src/compat.js';
import {createBridgeServer} from '../src/server.js';
import type {runProbe} from '../src/client.js';

const req=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}],tools:[{
  type:'function',function:{name:'edit',parameters:{type:'object',properties:{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},required:['file_path','old_string','new_string'],additionalProperties:false}},
},{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}}]});
const args={file_path:'D:\\project\\中文 file.cs',old_string:'before\n"quoted"',new_string:'after\n</｜｜DSML｜｜ parameter> literal <｜｜DSML｜｜ invoke name="read">'};
const wrap=(value:unknown=args,flag='false')=>'<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="tool_call" name="edit">\n'+
  `<｜｜DSML｜｜ parameter name="arguments" string="${flag}">${JSON.stringify(value)}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;

test('named generic wrapper preserves one explicit native tool and the exact complete arguments',()=>{
  for(const flag of ['true','false']){
    const repairs:DecisionRepair[]=[];
    assert.deepEqual(parseDecision(wrap(args,flag),req,r=>repairs.push(r)),{kind:'tool_call',name:'edit',arguments:args});
    assert.deepEqual(repairs,[{kind:'named_generic_wrapper',tool:'edit',parameter:'call'}]);
  }
  const canonical={kind:'tool_call',name:'edit',arguments:{...args,new_string:wrap()}};
  assert.deepEqual(parseDecision(JSON.stringify(canonical),req),canonical);
});

test('named generic wrapper rejects ambiguity, incomplete fields, extra calls and tool restrictions',()=>{
  const source=wrap();
  const extra=source.replace('</｜｜DSML｜｜ calls>', '<｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="arguments" string="false">{"file_path":"other"}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>');
  for(const bad of [source.slice(0,-1),source+source,extra,
    source.replace('name="tool_call" name="edit"','name="read" name="edit"'),
    source.replace('name="tool_call" name="edit"','name="tool_call" name="edit" name="read"'),
    source.replace('name="tool_call" name="edit"','name="tool_call" name="missing"'),
    source.replace('</｜｜DSML｜｜ calls>','</｜｜DSML｜｜ tool_calls>'),
    source.replace(JSON.stringify(args),'{}'),source.replace(JSON.stringify(args),'{"file_path":"cut'),
    wrap({...args,file_path:123}),wrap({...args,extra:true}),wrap([args]),wrap(null),
    source.replace('</｜｜DSML｜｜ invoke>','<｜｜DSML｜｜ parameter name="extra" string="true">x</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>'),
  ]){
    const repairs:DecisionRepair[]=[];
    assert.throws(()=>parseDecision(bad,req,r=>repairs.push(r)));
    assert.deepEqual(repairs,[]);
  }
  const alias={type:'function' as const,function:{name:'tool_call',parameters:{type:'object'}}};
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...req,tools:[...req.tools!,alias]})),/conflicts/);
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...req,tools:[...req.tools!,req.tools![0]]})),/one supplied tool/);
  const nativeArgs=ChatRequest.parse({...req,tools:[{...req.tools![0],function:{...req.tools![0]!.function,parameters:{type:'object',properties:{arguments:{type:'object'}}}}}]});
  assert.throws(()=>parseDecision(source,nativeArgs),/native arguments/);
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...req,tool_choice:'none'})),/forbids/);
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...req,tool_choice:{type:'function',function:{name:'read'}}})),/unselected/);
});

test('SSE emits one exact named wrapper call and emits no partial call for extra batch data',async()=>{
  const reportDir=await mkdtemp(join(tmpdir(),'qoderbridge-named-wrapper-'));
  for(const invalid of [false,true]){
    const fake=(async()=>({response:invalid?wrap()+wrap():wrap(),error:null,stage:'inference'})) as unknown as typeof runProbe;
    const server=await createBridgeServer({auth:'cli',timeout:5000,strategy:'permission',system:'test'},{port:0,key:'test',infer:fake,reportDir});
    try{
      const port=(server.address() as AddressInfo).port;
      const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({...req,stream:true})});
      const events=(await response.text()).split('\n\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
      const calls=events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);
      if(invalid){assert.equal(calls.length,0);assert.ok(events.some(e=>e.error));}
      else{assert.equal(calls.length,1);assert.equal(calls[0].function.name,'edit');assert.deepEqual(JSON.parse(calls[0].function.arguments),args);assert.ok(events.some(e=>e.choices?.[0]?.finish_reason==='tool_calls'));}
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});
