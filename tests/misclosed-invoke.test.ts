import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatRequest,parseDecision,type DecisionRepair} from '../src/compat.js';
const request=ChatRequest.parse({model:'qoder-deepseek-flash',messages:[{role:'user',content:'fixture'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer'}},required:['file_path'],additionalProperties:false}}}]});
const p=(value:string)=>`<｜｜DSML｜｜ parameter name="file_path" string="true">${value}</｜｜DSML｜｜ parameter>`;
const source=`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read">${p('first.txt')}</｜｜DSML｜｜ invoke>`+
  `</｜｜DSML｜｜ invoke name="read">${p('中文 second.txt')}<｜｜DSML｜｜ parameter name="offset" string="false">12</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
test('a named next-call opener with one stray slash is recovered only after the preceding invocation fully closed',()=>{
  const repairs:DecisionRepair[]=[];
  assert.deepEqual(parseDecision(source,request,r=>repairs.push(r)),{kind:'tool_calls',calls:[{name:'read',arguments:{file_path:'first.txt'}},{name:'read',arguments:{file_path:'中文 second.txt',offset:12}}]});
  assert.deepEqual(repairs,[{kind:'misclosed_invoke_opener',tool:'read',parameter:'call'}]);
});
test('unknown names, incomplete boundaries, extra data and invalid arguments still reject the whole batch',()=>{
  const cut=source.indexOf('</｜｜DSML｜｜ invoke>');
  for(const bad of [source.replace('</｜｜DSML｜｜ invoke name="read">','</｜｜DSML｜｜ invoke name="unknown">'),
    source.slice(0,cut)+source.slice(cut+'</｜｜DSML｜｜ invoke>'.length),source.replace(/<\/｜｜DSML｜｜ invoke><\/｜｜DSML｜｜ calls>$/,'</｜｜DSML｜｜ calls>'),
    source+source,source.replace('>12</','>"12"</'),source.replace(p('中文 second.txt'),''),source.replace('</｜｜DSML｜｜ calls>','</｜｜DSML｜｜ calls>extra')]){
    const repairs:DecisionRepair[]=[];assert.throws(()=>parseDecision(bad,request,r=>repairs.push(r)));assert.deepEqual(repairs,[]);
  }
  assert.throws(()=>parseDecision(source,ChatRequest.parse({...request,tool_choice:'none'})));
});
test('invoke-like text within an opaque parameter or JSON arguments is unchanged',()=>{
  const literal='before </｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ invoke name="read"> after';
  const one=`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read">${p(literal)}</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
  assert.deepEqual(parseDecision(one,request),{kind:'tool_call',name:'read',arguments:{file_path:literal}});
  const packed=`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read"><｜｜DSML｜｜ parameter name="arguments" string="false">${JSON.stringify({file_path:literal})}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
  assert.deepEqual(parseDecision(packed,request),{kind:'tool_call',name:'read',arguments:{file_path:literal}});
});
