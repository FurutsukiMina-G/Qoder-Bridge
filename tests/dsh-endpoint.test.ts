import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as tcpServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {dshFetch,dshOriginPort,proveDshOrigin,type DshInventory} from '../src/dsh-endpoint.js';

const parent={pid:100,parentPid:1,exe:'D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe',commandLine:'"D:\\Apps\\DeepSeek Harness\\DeepSeek Harness.exe"'};
const entry='D:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js';
const host={pid:101,parentPid:100,exe:parent.exe,commandLine:`"${parent.exe}" --expose-internals "${entry}" "D:\\profile"`};
const inventory=(port:number):DshInventory=>({processes:[parent,host],listeners:[{pid:101,address:'127.0.0.1',port}]});
test('only the actual DSH host entry and owning listener qualify, not a name or a parent-process association',()=>{
  assert.deepEqual(proveDshOrigin('http://127.0.0.1:19387',inventory(19387)),{port:19387,pid:101});
  for(const bad of [
    {...inventory(19387),listeners:[{pid:102,address:'127.0.0.1',port:19387}]},
    {...inventory(19387),processes:[parent,{...host,commandLine:`"${parent.exe}" --type=gpu-process`}]},
    {...inventory(19387),processes:[{...parent,exe:'C:\\Windows\\explorer.exe'},host]},
    {...inventory(19387),processes:[parent,{...host,commandLine:`"${parent.exe}" --log="${entry}"`}]},
    {...inventory(19387),processes:[parent,{...host,exe:'C:\\Unrelated\\node.exe'}]},
    {...inventory(19387),listeners:[{pid:101,address:'127.0.0.1',port:19387},{pid:102,address:'::1',port:19387}]},
  ])assert.throws(()=>proveDshOrigin('http://127.0.0.1:19387',bad));
});
test('custom CLI hosts require an explicit exact entry argument; generic Node and other applications never qualify',()=>{
  const cli='C:\\tools\\dsh cli\\main.js';
  const node={pid:1,parentPid:0,exe:'C:\\Node\\node.exe',commandLine:`"C:\\Node\\node.exe" "${cli}" web`};
  const data={processes:[node],listeners:[{pid:1,address:'127.0.0.1',port:3080}]};
  assert.throws(()=>proveDshOrigin('http://127.0.0.1:3080',data));
  assert.equal(proveDshOrigin('http://127.0.0.1:3080',data,cli).pid,1);
  assert.throws(()=>proveDshOrigin('http://127.0.0.1:3080',{...data,processes:[{...node,exe:'C:\\Games\\game.exe'}]},cli));
  assert.throws(()=>proveDshOrigin('http://127.0.0.1:3080',{...data,processes:[{...node,commandLine:node.commandLine.replace(`"${cli}"`,`"${cli}.other"`)}]},cli));
});
test('origins and request paths cannot redirect credential-bearing requests out of the selected loopback origin',async()=>{
  for(const origin of ['https://127.0.0.1:19387','http://localhost:19387','http://127.0.0.1:19387/path','http://user:secret@127.0.0.1:19387','http://127.0.0.1:19387?next=other','http://127.0.0.1:99999'])assert.throws(()=>dshOriginPort(origin));
  let calls=0;const deps={inventory:async()=>inventory(19387),fetch:(async()=>{calls++;return new Response('ok')}) as typeof fetch};
  for(const path of ['//127.0.0.1:43557/','/\\other','relative','/bad\npath'])await assert.rejects(dshFetch('http://127.0.0.1:19387',path,{},deps));
  assert.equal(calls,0);
});
test('stale cached/log-derived ports owned by a game-like binary IPC server receive zero connections and zero bytes',async()=>{
  let connections=0,bytes=0;
  const server=tcpServer(socket=>{connections++;socket.on('data',data=>{bytes+=data.length});socket.on('error',()=>{});socket.resume()});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  const wrong:DshInventory={processes:[{pid:400,parentPid:1,exe:'C:\\Users\\Fixture\\Games\\game\\game.exe',commandLine:'game.exe'}],listeners:[{pid:400,address:'127.0.0.1',port}]};
  try{
    for(const path of ['/api/settings/describe','/?token=SYNTHETIC_SECRET'])await assert.rejects(dshFetch(`http://127.0.0.1:${port}`,path,{method:'POST',headers:{cookie:'SYNTHETIC_COOKIE'},body:'SYNTHETIC_RPC',signal:AbortSignal.timeout(300)},{inventory:async()=>wrong}),/not owned by a verified DSH host/);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(connections,0);assert.equal(bytes,0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
test('ownership failures and inspection denial fail closed without a fallback HTTP probe',async()=>{
  let calls=0;const fake=(async()=>{calls++;return new Response('unexpected')}) as typeof fetch;
  for(const inspect of [async()=>{throw new Error('access denied')},async()=>({processes:[],listeners:[]})])
    await assert.rejects(dshFetch('http://127.0.0.1:43557','/',{}, {inventory:inspect,fetch:fake}));
  assert.equal(calls,0);
});
test('each request rechecks ownership so a port cannot remain trusted after being reused by another process',async()=>{
  let snapshots=0,calls=0;
  const deps={inventory:async()=>++snapshots===1?inventory(19387):{processes:[],listeners:[]},fetch:(async()=>{calls++;return new Response('ok')}) as typeof fetch};
  await dshFetch('http://127.0.0.1:19387','/api/settings/describe',{},deps);
  await assert.rejects(dshFetch('http://127.0.0.1:19387','/api/session/list',{},deps));
  assert.equal(snapshots,2);assert.equal(calls,1);
});
test('slow OS inspection does not consume the login HTTP timeout, and pre-cancelled requests send nothing',async()=>{
  let calls=0;
  const deps={timeoutMs:10,inventory:async()=>{await new Promise(resolve=>setTimeout(resolve,25));return inventory(19387)},fetch:(async(_url,init)=>{calls++;assert.equal(init?.signal?.aborted,false);return new Response('ok')}) as typeof fetch};
  await dshFetch('http://127.0.0.1:19387','/',{},deps);
  await assert.rejects(dshFetch('http://127.0.0.1:19387','/',{signal:AbortSignal.abort()},deps));
  assert.equal(calls,1);
});
test('even a verified DSH origin cannot redirect probes or cookies to an unrelated local application',async()=>{
  let targetHits=0;
  const target=httpServer((_req,res)=>{targetHits++;res.end('unrelated')});await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
  const source=httpServer((_req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${(target.address() as AddressInfo).port}/`});res.end()});await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve));
  const port=(source.address() as AddressInfo).port;
  try{const response=await dshFetch(`http://127.0.0.1:${port}`,'/',{headers:{cookie:'SYNTHETIC'},redirect:'follow'},{inventory:async()=>inventory(port)});assert.equal(response.status,302);assert.equal(targetHits,0);await response.arrayBuffer()}
  finally{await new Promise<void>(resolve=>source.close(()=>resolve()));await new Promise<void>(resolve=>target.close(()=>resolve()))}
});
