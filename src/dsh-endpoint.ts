import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32,resolve} from 'node:path';

export type LocalProcess={pid:number;parentPid:number;exe:string;commandLine:string};
export type LocalListener={pid:number;address:string;port:number};
export type DshInventory={processes:LocalProcess[];listeners:LocalListener[]};
const normalize=(path:string)=>path.replaceAll('/','\\').toLowerCase();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function hasArgument(command:string,path:string){
  const value=escape(normalize(path));
  return new RegExp(`(?:^|\\s)(?:"${value}"|${value})(?=\\s|$)`,'i').test(normalize(command));
}
export function dshOriginPort(origin:string){
  let url:URL;try{url=new URL(origin)}catch{throw new Error('Invalid DSH loopback origin')}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('DSH endpoint must be an HTTP 127.0.0.1 origin without credentials or a path');
  return Number(url.port||80);
}
function isDshHost(host:LocalProcess,inventory:DshInventory,explicitEntry?:string){
  const exe=normalize(host.exe),name=win32.basename(exe);
  if(!['deepseek harness.exe','node.exe'].includes(name))return false;
  if(explicitEntry&&win32.isAbsolute(explicitEntry)&&hasArgument(host.commandLine,explicitEntry))return true;
  const parent=inventory.processes.find(p=>p.pid===host.parentPid&&p.pid!==host.pid);
  if(!parent||win32.basename(normalize(parent.exe))!=='deepseek harness.exe')return false;
  const desktopRoot=win32.dirname(parent.exe);
  const entry=win32.join(desktopRoot,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','index.js');
  // Electron's Node host uses the same EXE; older bundles may use their own Node runtime.
  if(exe!==normalize(parent.exe)&&!exe.startsWith(normalize(desktopRoot)+'\\'))return false;
  return hasArgument(host.commandLine,entry);
}
/** No HTTP/TCP probe is performed: endpoint ownership comes only from the OS process/listener table. */
export function proveDshOrigin(origin:string,inventory:DshInventory,explicitEntry?:string){
  const port=dshOriginPort(origin);
  const listeners=inventory.listeners.filter(l=>l.port===port&&['127.0.0.1','0.0.0.0','::','::1'].includes(l.address));
  if(!listeners.length)throw new Error('DSH endpoint has no verified local listener; no HTTP request was sent');
  const owners=[...new Set(listeners.map(l=>l.pid))];
  if(owners.length!==1)throw new Error('DSH endpoint ownership is ambiguous; no HTTP request was sent');
  const host=inventory.processes.find(p=>p.pid===owners[0]);
  if(!host||!isDshHost(host,inventory,explicitEntry))
    throw new Error('Local port is not owned by a verified DSH host; no HTTP request was sent');
  return{port,pid:host.pid};
}
const exec=promisify(execFile);
export async function windowsDshInventory():Promise<DshInventory>{
  if(process.platform!=='win32')throw new Error('DSH process ownership verification is currently supported on Windows only');
  try{
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('scripts/dsh-owned-listeners.ps1')],
      {windowsHide:true,timeout:15000,maxBuffer:1024*1024,encoding:'utf8'});
    const parsed=JSON.parse(stdout.replace(/^\uFEFF/,''));
    if(!Array.isArray(parsed.processes)||!Array.isArray(parsed.listeners))throw new Error('Invalid process snapshot');
    return parsed;
  }catch{throw new Error('Cannot verify DSH listener ownership; no HTTP request was sent. Run from the repository root with permission to read local process/listener metadata.')}
}
/** Recheck even cached ports before sending cookies, login tokens or HTTP bytes; never follow redirects. */
export async function dshFetch(origin:string,path:string,init:RequestInit={},deps:{
  inventory?:()=>Promise<DshInventory>;fetch?:typeof fetch;explicitEntry?:string;timeoutMs?:number;
}={}){
  dshOriginPort(origin);
  if(deps.timeoutMs!==undefined&&(!Number.isSafeInteger(deps.timeoutMs)||deps.timeoutMs<=0))throw new Error('Invalid DSH HTTP timeout');
  init.signal?.throwIfAborted();
  if(!path.startsWith('/')||path.startsWith('//')||/[\\\r\n]/.test(path))throw new Error('Invalid DSH request path');
  const target=new URL(path,origin);
  if(target.origin!==new URL(origin).origin)throw new Error('DSH request cannot leave its verified origin');
  proveDshOrigin(origin,await(deps.inventory??windowsDshInventory)(),deps.explicitEntry??process.env.DSH_HOST_ENTRY);
  init.signal?.throwIfAborted();
  // Process inspection has its own bound; do not consume a short login HTTP timeout before sending it.
  const deadline=deps.timeoutMs===undefined?undefined:AbortSignal.timeout(deps.timeoutMs);
  const signal=init.signal&&deadline?AbortSignal.any([init.signal,deadline]):init.signal??deadline;
  return(deps.fetch??fetch)(target,{...init,...(signal?{signal}:{}),redirect:'manual'});
}
