import Ajv from 'ajv';
import type {ChatRequest} from './compat.js';

// HTTP bodies recreate schema objects. A process-wide Ajv.compile(object)
// cache would keep each copy forever; key by content and bound retained validators.
const validators=new Map<string,ReturnType<InstanceType<typeof Ajv.default>['compile']>>();
const MAX_VALIDATORS=128;
export function toolValidator(schema:object|boolean){
  const key=JSON.stringify(schema);
  let validate=validators.get(key);
  if(validate){validators.delete(key);validators.set(key,validate);return validate;}
  // Isolate $id namespaces across independent client tool catalogs.
  validate=new Ajv.default({allErrors:true,strict:false,validateFormats:false}).compile(schema);
  validators.set(key,validate);
  if(validators.size>MAX_VALIDATORS)validators.delete(validators.keys().next().value!);
  return validate;
}
export function assertToolContract(request:ChatRequest){
  const names=new Set<string>();
  for(const tool of request.tools??[]){
    const {name,parameters}=tool.function;
    if(names.has(name))throw new Error(`Duplicate tool name: ${name}`);
    names.add(name);
    if(parameters===undefined)continue;
    if(parameters===null||Array.isArray(parameters)||!['object','boolean'].includes(typeof parameters))
      throw new Error(`Invalid JSON schema for tool ${name}`);
    if(parameters===false)throw new Error(`Tool ${name} has an unsatisfiable false schema`);
    toolValidator(parameters as object|boolean);
  }
  const choice=request.tool_choice;
  if(typeof choice==='string'&&!['auto','none','required'].includes(choice))throw new Error('Invalid tool_choice');
  if(choice==='required'&&!names.size)throw new Error('tool_choice requires at least one supplied tool');
  if(choice&&typeof choice==='object'&&'function' in choice){
    const name=(choice.function as {name?:unknown}|null)?.name;
    if(typeof name!=='string'||!names.has(name))throw new Error('tool_choice selects an unavailable tool');
  }
}
