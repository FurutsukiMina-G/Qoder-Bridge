import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { diagnosticToolName } from './diagnostics.js';
import {toolValidator} from './tool-contract.js';

const Message = z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.unknown().optional(), tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(), name: z.string().optional() }).passthrough();
const Tool = z.object({ type: z.literal('function'), function: z.object({
  name: z.string().min(1), description: z.string().optional(), parameters: z.unknown().optional(),
}).passthrough() }).passthrough();
export const ChatRequest = z.object({
  model: z.string(), messages: z.array(Message).min(1), tools: z.array(Tool).optional(),
  tool_choice: z.unknown().optional(), stream: z.boolean().optional(),
  prompt_cache_key: z.string().min(1).optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(), stream_options: z.unknown().optional(),
  /** OpenAI-style level picked in the client; applied per request when the model offers it. */
  reasoning_effort: z.string().optional(),
}).passthrough();
export type ChatRequest = z.infer<typeof ChatRequest>;
const Decision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('final'), content: z.string() }).strict(),
  z.object({ kind: z.literal('tool_call'), name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal('tool_calls'), calls: z.array(z.object({
    name: z.string(), arguments: z.record(z.string(), z.unknown()),
  }).strict()).min(1) }).strict(),
]);
export type Decision = z.infer<typeof Decision>;
export type DecisionRepair = { kind: 'misclosed_parameter' | 'shorthand_parameter' | 'encoded_arguments' | 'encoded_content_quotes' |
  'parameter_annotation' | 'attributed_shorthand_parameter' | 'identical_parameter' | 'call_wrapper_close' |
  'unwrapped_call' | 'redundant_tool_name' | 'flat_tool_kind' | 'alternate_ds' | 'repeated_dsml' |
  'prefix_shorthand_parameter' | 'packed_content_quotes' | 'arguments_wrapper_close' |
  'decision_wrapper_close' | 'parameter_boundary' | 'schema_matched_call' | 'empty_call_annotation' |
  'tool_calls_envelope' | 'flat_call_arguments' | 'decorated_calls_envelope' | 'attribute_parameters' |
  'terminal_field_stub' | 'custom_tool_envelope' | 'localized_parameter' | 'generic_arguments_boundary' |
  'attributed_call_envelope' | 'named_generic_wrapper' | 'plain_tool_envelope' | 'redundant_decision_closers' | 'missing_calls_opener' |
  'missing_calls_parameter_wrapper' | 'generic_shorthand_name' | 'plain_write_parameters'; tool: string; parameter: string };
function parseJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (original) {
    let quoted = false; let escaped = false; let changed = false; let repaired = '';
    for (const char of text) {
      if (escaped) { escaped = false; repaired += char; continue; }
      if (char === '\\' && quoted) { escaped = true; repaired += char; continue; }
      if (char === '"') { quoted = !quoted; repaired += char; continue; }
      if (quoted && char.charCodeAt(0) < 32) {
        changed = true;
        repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else repaired += char;
    }
    if (changed) return JSON.parse(repaired);
    throw original;
  }
}
function objectRange(text: string, start: number): { value: unknown; end: number } {
  if (start < 0 || text[start] !== '{') throw new Error('Decision JSON object is missing');
  let depth = 0; let quoted = false; let escaped = false; let end = -1;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('Decision JSON object is incomplete');
  return { value: parseJson(text.slice(start, end)), end };
}
function objectAt(text: string, start: number): unknown { return objectRange(text, start).value; }
function arrayRange(text: string, start: number): { value: unknown; end: number } {
  if (start < 0 || text[start] !== '[') throw new Error('Decision JSON array is missing');
  const stack: string[] = []; let quoted = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[') stack.push(']');
    else if (char === '{') stack.push('}');
    else if (char === ']' || char === '}') {
      if (stack.pop() !== char) throw new Error('Decision JSON array has mismatched delimiters');
      if (!stack.length) return { value: parseJson(text.slice(start, i + 1)), end: i + 1 };
    }
  }
  throw new Error('Decision JSON array is incomplete');
}
function arrayAt(text: string, start: number): unknown { return arrayRange(text, start).value; }
function alternateDsDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const start = /<｜｜(DS|DSML)｜｜\s*tool_calls\s*｜｜\1｜｜>?/.exec(text);
  if (!start) return null;
  const marker = start[1]!;
  const repeated = new RegExp(`^<?｜｜${marker}｜｜\\s*(\\/?\\w+)(?:\\s+name="([^"]+)")?(?:\\s+string="(true|false)")?\\s*｜｜${marker}｜｜>?`);
  const standardOpen = new RegExp(`^<｜｜${marker}｜｜\\s*(invoke|parameter)(?:\\s+name="([^"]+)")?(?:\\s+string="(true|false)")?\\s*>`);
  const inverted = new RegExp(`^<｜｜/${marker}｜｜\\s*(invoke|tool_calls)\\s*｜｜${marker}｜｜>?`);
  const canonical = new RegExp(`^</｜｜${marker}｜｜\\s*(parameter|invoke|tool_calls)\\s*>`);
  const parameterClose = new RegExp(`<?｜｜${marker}｜｜\\s*/parameter\\s*｜｜${marker}｜｜>?|</｜｜${marker}｜｜\\s*parameter\\s*>`);
  let cursor = start.index + start[0].length;
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const token = () => {
    while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
    const remainder = text.slice(cursor);
    const match = repeated.exec(remainder) ?? standardOpen.exec(remainder);
    if (!match) {
      const close = inverted.exec(remainder) ?? canonical.exec(remainder);
      if (!close) throw new Error('Alternate DS tool block is incomplete or malformed');
      cursor += close[0].length;
      return { kind: `/${close[1]!}`, name: undefined, stringFlag: undefined };
    }
    cursor += match[0].length;
    return { kind: match[1]!, name: match[2], stringFlag: match[3] };
  };
  while (true) {
    const open = token();
    if (open.kind === '/tool_calls') {
      if (text.slice(cursor).trim()) throw new Error('Unexpected data after alternate DS calls');
      return Decision.parse(calls.length === 1 ? { kind: 'tool_call', ...calls[0] } : { kind: 'tool_calls', calls });
    }
    if (open.kind !== 'invoke' || !open.name) throw new Error('Alternate DS call name is missing');
    const name = open.name;
    const provided = request.tools?.filter(tool => tool.function.name === name) ?? [];
    if (provided.length !== 1) throw new Error(`Unknown or ambiguous alternate DS tool: ${name}`);
    const schema = provided[0]!.function.parameters as { properties?: Record<string, { type?: unknown }> } | undefined;
    const args: Record<string, unknown> = {};
    while (true) {
      const field = token();
      if (field.kind === '/invoke') break;
      if (field.kind !== 'parameter' || !field.name) throw new Error('Alternate DS parameter name is missing');
      const type = schema?.properties?.[field.name]?.type;
      const packed = field.name === 'arguments' && !Object.hasOwn(schema?.properties ?? {}, 'arguments');
      if (!field.stringFlag && !packed && !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(String(type)))
        throw new Error(`Alternate DS parameter type is not declared: ${field.name}`);
      const isString = field.stringFlag ? field.stringFlag === 'true' : type === 'string';
      const valueStart = cursor;
      let value: unknown;
      if (!isString) {
        let jsonStart = cursor;
        while (jsonStart < text.length && /\s/.test(text[jsonStart]!)) jsonStart++;
        if (text[jsonStart] === '{' || text[jsonStart] === '[') {
          const range = text[jsonStart] === '{' ? objectRange(text, jsonStart) : arrayRange(text, jsonStart);
          value = range.value; cursor = range.end;
        } else {
          const close = parameterClose.exec(text.slice(valueStart));
          if (!close) throw new Error('Alternate DS parameter is incomplete');
          cursor = valueStart + close.index;
          value = parseJson(text.slice(valueStart, cursor).trim());
        }
      } else {
        const close = parameterClose.exec(text.slice(valueStart));
        if (close) {
          cursor = valueStart + close.index;
          value = text.slice(valueStart, cursor);
        } else {
          // Observed final workdir has a bare parameter marker immediately
          // before the explicit invoke close. Recover only this path boundary.
          const broken = marker === 'DSML' && field.name === 'workdir' && type === 'string'
            ? /｜｜DSML｜｜parameter>(?=\s*<｜｜\/DSML｜｜invoke｜｜DSML｜｜>?)/.exec(text.slice(valueStart)) : null;
          const path = broken ? text.slice(valueStart, valueStart + broken.index) : '';
          if (!broken || !/^[A-Za-z]:\\[^<\r\n]*$/.test(path)) throw new Error('Alternate DS parameter is incomplete');
          value = path;
          cursor = valueStart + broken.index + broken[0].length;
          repairs.push({ kind: 'misclosed_parameter', tool: name, parameter: field.name });
          if (Object.hasOwn(args, field.name) && !isDeepStrictEqual(args[field.name], value))
            throw new Error(`Duplicate DS parameter: ${field.name}`);
          args[field.name] = value;
          continue;
        }
      }
      if (token().kind !== '/parameter') throw new Error('Alternate DS parameter closing tag is missing');
      if (Object.hasOwn(args, field.name) && !isDeepStrictEqual(args[field.name], value))
        throw new Error(`Duplicate DS parameter: ${field.name}`);
      args[field.name] = value;
    }
    const keys = Object.keys(args);
    const packed = keys.length === 1 && keys[0] === 'arguments' && !Object.hasOwn(schema?.properties ?? {}, 'arguments');
    calls.push({ name, arguments: packed ? z.record(z.string(), z.unknown()).parse(args.arguments) : args });
    repairs.push({ kind: marker === 'DSML' ? 'repeated_dsml' : 'alternate_ds', tool: name, parameter: 'call' });
  }
}
function callsArray(text: string, repairs: DecisionRepair[], completeEnvelope = false): unknown {
  try { return parseJson(text); }
  catch (original) {
    // Some SDK-formatted call arrays carry an extra closing brace after the
    // complete array. Ignore only unmatched closing delimiters, never prose
    // or another tool call, and validate every recovered call below.
    const end = text.lastIndexOf(']');
    if (end >= 0 && /^[}\]\s]+$/.test(text.slice(end + 1))) {
      try {
        const recovered = parseJson(text.slice(0, end + 1));
        if (Array.isArray(recovered)) return recovered;
      } catch { /* A complete array may still have a missing call wrapper. */ }
    }
    // An added outer brace must never masquerade as a missing call close.
    // Use the closed wrapper only when the array itself already ended.
    const restored = (/\]\s*$/.test(text) ? missingCallClosures(`{"kind":"tool_calls","calls":${text.trim()}}`) : null) ??
      (completeEnvelope ? missingCallClosures(`{"kind":"tool_calls","calls":${text.trim()}`) : null);
    if (restored) {
      repairs.push(...restored.repairs);
      return (restored.value as { calls: unknown[] }).calls;
    }
    throw original;
  }
}
function repairParameterMarkers(fragment: string, tool: string, request: ChatRequest,
  repairs: DecisionRepair[]): string {
  // An explicit JSON arguments object may contain literal protocol text as data.
  // Its parser already preserves strings; don't rewrite inside that representation.
  if (/<｜｜DSML｜｜\s*parameter\s+name="arguments"(?:\s[^>]*>|\s*:)/.test(fragment)) return fragment;
  if (tool === 'tool_call') {
    const boundary = /(<｜｜DSML｜｜\s*parameter\s+name="name"\s+string="true"\s*>)([A-Za-z_][\w-]*)<\/｜｜DSML｜｜\s*parameter\s+name="arguments"\s+string="false"\s*>\s*/.exec(fragment);
    if (boundary && (request.tools ?? []).filter(entry => entry.function.name === boundary[2]).length === 1) {
      // The name's close carries the next field's attributes. Require the full
      // argument object and its own close before separating these two fields.
      const start = boundary.index + boundary[0].length;
      const args = objectRange(fragment, start);
      if (!/^\s*<\/｜｜DSML｜｜\s*parameter\s*>/.test(fragment.slice(args.end)))
        throw new Error('Generic DSML arguments closing boundary is missing');
      fragment = fragment.slice(0, boundary.index) + boundary[1] + boundary[2] +
        '</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="arguments" string="false">' + fragment.slice(start);
      repairs.push({ kind: 'generic_arguments_boundary', tool: boundary[2]!, parameter: 'arguments' });
      return fragment;
    }
  }
  const schema = request.tools?.find(entry => entry.function.name === tool)?.function.parameters as
    { properties?: Record<string, { type?: unknown }> } | undefined;
  const properties = schema?.properties ?? {};
  // The recorded response translated only the parameter opener into Chinese.
  // Restore it only immediately after a closed parameter, with a declared string
  // and its complete canonical closing boundary. The value remains opaque.
  fragment = fragment.replace(/(<\/｜｜DSML｜｜\s*parameter\s*>\s*)<｜参数 name="([A-Za-z_]\w*)">([\s\S]*?)(?=<\/｜｜DSML｜｜\s*parameter\s*>)/g,
    (source, boundary: string, name: string, value: string) => {
      if (properties[name]?.type !== 'string' || /｜｜DSML｜｜|<｜参数/.test(value))
        throw new Error(`Ambiguous or undeclared localized DSML parameter: ${name}`);
      repairs.push({ kind: 'localized_parameter', tool, parameter: name });
      return `${boundary}<｜｜DSML｜｜ parameter name="${name}" string="true">${value}`;
    });
  fragment = fragment.replace(/<｜｜DSML｜｜\s+file_path="([^"\r\n]+)"\s+old_string="([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g,
    (source, path: string, old: string) => {
      // Recorded edit header lost its closing quote/angle, but retained the
      // explicit parameter close. A complete code block boundary is required.
      if (tool !== 'edit' || properties.file_path?.type !== 'string' || properties.old_string?.type !== 'string' ||
          properties.new_string?.type !== 'string' || /｜｜DSML｜｜/.test(old) || !/}\s*$/.test(old)) return source;
      repairs.push({ kind: 'attribute_parameters', tool, parameter: 'file_path,old_string' });
      return `<｜｜DSML｜｜ parameter name="file_path" string="true">${path}</｜｜DSML｜｜ parameter>` +
        `<｜｜DSML｜｜ parameter name="old_string" string="true">${old}</｜｜DSML｜｜ parameter>`;
    });
  fragment = fragment.replace(/(<｜｜DSML｜｜\s*parameter\s+name="file_path"(?:\s+string="true")?\s*>)([^<｜]*?)(?<![<\/])｜｜DSML｜｜\s*parameter\s+name="old_string"(?:\s+string="true")?\s*>/g,
    (source, open: string, path: string) => {
      if (properties.file_path?.type !== 'string' || properties.old_string?.type !== 'string' ||
        !path.trim() || /[\r\n]/.test(path.trim())) return source;
      repairs.push({ kind: 'parameter_boundary', tool, parameter: 'old_string' });
      return `${open}${path}</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="old_string" string="true">`;
    });
  // Recorded shorthand puts the explicit field name before the DSML marker.
  // Only a declared string with its complete closing boundary can be restored.
  fragment = fragment.replace(/<｜\s+([A-Za-z_]\w*)｜｜DSML｜｜>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g,
    (source, name: string, value: string) => {
      if (!Object.hasOwn(properties, name) || properties[name]?.type !== 'string' || /｜｜DSML｜｜/.test(value)) return source;
      repairs.push({ kind: 'prefix_shorthand_parameter', tool, parameter: name });
      return `<｜｜DSML｜｜ parameter name="${name}" string="true">${value}</｜｜DSML｜｜ parameter>`;
    });
  // Observed corruption closes one parameter with the attributes of the next.
  // Preserve that boundary and open the explicitly named field; never invent a value.
  fragment = fragment.replace(/<\/｜｜DSML｜｜\s*parameter\s+name="([A-Za-z_]\w*)"(?:\s+string="(true|false)")?\s*>/g,
    (source, name: string, stringFlag: string) => {
      if (!Object.hasOwn(properties, name) || (!stringFlag && properties[name]?.type !== 'string')) return source;
      repairs.push({ kind: 'misclosed_parameter', tool, parameter: name });
      return `</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="${name}" string="${stringFlag ?? 'true'}">`;
    });
  // The other observed form is <DSML pattern"literal</DSML parameter>.
  // Recover only a declared string field with a complete, unambiguous closing tag.
  return fragment.replace(/<｜｜DSML｜｜\s+([A-Za-z_]\w*)"([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g,
    (source, name: string, value: string) => {
      if (!Object.hasOwn(properties, name) || properties[name]?.type !== 'string' ||
        /<\/?｜｜DSML｜｜/.test(value)) return source;
      // <DSML new_string" = ""/> is a self-closing annotation, not the
      // observed missing-header form. Don't turn it into a second value.
      if (/^\s*=\s*"[^"\r\n]*"\s*\/>/.test(value)) {
        // The recorded placeholder also carries the literal filler "junk"
        // after the self-closing tag. Neither is an actual parameter value.
        if (!/^\s*=\s*""\s*\/>\s*(?:junk\s*)?$/.test(value)) throw new Error(`Ambiguous DSML parameter annotation: ${name}`);
        const declared = [...fragment.matchAll(new RegExp(`<｜｜DSML｜｜\\s*parameter\\s+name="${name}"[^>]*>`, 'g'))];
        if (declared.length === 1) repairs.push({ kind: 'parameter_annotation', tool, parameter: name });
        return source;
      }
      const attributed = /^\s+string="true"\s*>([\s\S]*)$/.exec(value);
      if (attributed) {
        repairs.push({ kind: 'attributed_shorthand_parameter', tool, parameter: name });
        return `<｜｜DSML｜｜ parameter name="${name}" string="true">${attributed[1]}</｜｜DSML｜｜ parameter>`;
      }
      repairs.push({ kind: 'shorthand_parameter', tool, parameter: name });
      return `<｜｜DSML｜｜ parameter name="${name}" string="true">${value}</｜｜DSML｜｜ parameter>`;
    });
}
function invocationEnd(fragment: string): number | null {
  const tokens = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"[^>]*>|<\/｜｜DSML｜｜\s*invoke\s*>/g;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(fragment))) {
    if (token[1] === undefined) return tokens.lastIndex;
    const valueStart = tokens.lastIndex;
    if (token[1] === 'arguments') {
      const start = fragment.indexOf('{', valueStart);
      if (start >= 0) {
        try { tokens.lastIndex = objectRange(fragment, start).end; continue; }
        catch { /* Normal decision validation will reject incomplete arguments. */ }
      }
    }
    // Invoke-like text in a scalar value is data, not a call boundary.
    const remainder = fragment.slice(valueStart);
    let closing = /<\/｜｜DSML｜｜\s*parameter(?:\s[^>]*)?>/.exec(remainder);
    const bare = /<\/｜｜DSML｜｜\s*>/.exec(remainder);
    // Scalar fields already accept this abbreviated close during argument
    // parsing. Recognise it for invocation boundaries only after an explicit
    // non-string tag and a whole JSON primitive; never finish a value or
    // reinterpret a marker inside a string/JSON object.
    if (bare && (!closing || bare.index < closing.index) && /\bstring="false"/.test(token[0]) &&
        /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/.test(remainder.slice(0, bare.index).trim()))
      closing = bare;
    if (!closing) return null;
    tokens.lastIndex = valueStart + closing.index + closing[0].length;
    if (token[1] === 'name' && /^<\/｜｜DSML｜｜\s*parameter\s+name="arguments"\s+string="false"\s*>$/.test(closing[0])) {
      const start = fragment.indexOf('{', tokens.lastIndex);
      if (start >= 0 && !fragment.slice(tokens.lastIndex, start).trim()) {
        try { tokens.lastIndex = objectRange(fragment, start).end; }
        catch { return null; }
      }
    }
  }
  return null;
}
function unwrappedCalls(tail: string, repairs: DecisionRepair[], request: ChatRequest, owner = 'wrapper'): Array<{ name: string; arguments: unknown }> {
  if (/^\s*<｜｜DSML｜｜\s*parameter\s+name="tool_calls">\s*(?:<\/｜｜DSML｜｜\s*(?:calls|tool_calls)>\s*)?$/.test(tail) &&
      !(request.tools ?? []).some(tool => Object.hasOwn((tool.function.parameters as { properties?: object } | undefined)?.properties ?? {}, 'tool_calls'))) {
    repairs.push({ kind: 'empty_call_annotation', tool: owner, parameter: 'tool_calls' });
    return [];
  }
  if (!/<｜｜DSML｜｜\s*parameter\s+name="/.test(tail)) return [];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let cursor = 0;
  while (cursor < tail.length) {
    const remainder = tail.slice(cursor);
    const spacing = /^(?:\s|<\/｜｜DSML｜｜\s*(?:invoke|parameter|calls|tool_calls)\s*>)+/.exec(remainder);
    if (spacing) { cursor += spacing[0].length; continue; }
    const named = /^<｜｜DSML｜｜\s*parameter\s+name="name"(?:\s+string="true")?\s*>([^<]+)<\/｜｜DSML｜｜\s*parameter\s*>/.exec(remainder);
    if (!named) {
      const end = invocationEnd(remainder);
      if (end === null) throw new Error('Unwrapped DSML call must have a complete closing boundary');
      const fragment = remainder.slice(0, end);
      const fields = [...fragment.matchAll(/<\/?｜｜DSML｜｜\s*parameter\s+name="([^"]+)"/g)].map(field => field[1]!);
      // A closed parameter-form call may lose its invoke opener. All explicit
      // fields and every required field must identify exactly one supplied schema.
      const candidates = (request.tools ?? []).filter(tool => {
        const schema = tool.function.parameters as { properties?: Record<string, { type?: unknown }>; required?: unknown } | undefined;
        return fields.length > 0 && schema?.properties && Array.isArray(schema.required) && schema.required.length > 0 &&
          fields.every(field => schema.properties![field]?.type === 'string') && schema.required.every(field => typeof field === 'string' && fields.includes(field));
      });
      if (candidates.length !== 1) throw new Error('Unwrapped DSML parameter call has no unique supplied-tool schema');
      const name = candidates[0]!.function.name;
      const restored = dsmlDecision(`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="${name}">${fragment}</｜｜DSML｜｜ calls>`, request, repairs);
      if (restored?.kind !== 'tool_call') throw new Error('Unwrapped DSML parameter call is incomplete');
      calls.push({ name: restored.name, arguments: restored.arguments });
      repairs.push({ kind: 'schema_matched_call', tool: name, parameter: 'call' });
      cursor += end;
      continue;
    }
    const name = named[1]!.trim();
    cursor += named[0].length;
    const argumentTag = /^\s*<｜｜DSML｜｜\s*parameter\s+name="arguments"(?:\s+string="false")?\s*>\s*/.exec(tail.slice(cursor));
    if (!argumentTag) throw new Error('Unwrapped DSML call arguments are missing');
    cursor += argumentTag[0].length;
    const args = objectRange(tail, cursor);
    cursor = args.end;
    const close = /^\s*<\/｜｜DSML｜｜\s*parameter\s*>/.exec(tail.slice(cursor));
    if (!close) throw new Error('Unwrapped DSML arguments closing tag is missing');
    cursor += close[0].length;
    calls.push({ name, arguments: args.value });
    repairs.push({ kind: 'unwrapped_call', tool: name, parameter: 'call' });
  }
  return calls;
}
function dsmlDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const marker = /<｜｜DSML｜｜\s*(calls|tool_calls)>/.exec(text);
  const markerAt = marker?.index ?? -1;
  if (markerAt < 0) return null;
  text = text.slice(markerAt);
  // A repeated observed wrapper names the generic adapter first, then one
  // supplied native tool. Only a complete single call with one JSON object
  // is unambiguous; never pick between native tools or discard batch members.
  const namedWrapper = /^<｜｜DSML｜｜\s*(calls|tool_calls)>\s*<｜｜DSML｜｜\s*invoke name="tool_call" name="([A-Za-z_][\w.-]*)">\s*<｜｜DSML｜｜\s*parameter name="arguments" string="(?:true|false)">\s*(?=\{)/.exec(text);
  if (namedWrapper) {
    if ((request.tools ?? []).some(tool => tool.function.name === 'tool_call'))
      throw new Error('Named generic wrapper conflicts with a supplied tool');
    const provided = request.tools?.filter(tool => tool.function.name === namedWrapper[2]) ?? [];
    if (provided.length !== 1) throw new Error('Named generic wrapper requires one supplied tool');
    const schema = provided[0]!.function.parameters as { properties?: object } | undefined;
    if (schema?.properties && Object.hasOwn(schema.properties, 'arguments'))
      throw new Error('Named generic wrapper conflicts with a native arguments parameter');
    const args = objectRange(text, namedWrapper[0].length);
    const tail = /^\s*<\/｜｜DSML｜｜\s*parameter>\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(text.slice(args.end));
    if (!tail || tail[1] !== namedWrapper[1])
      throw new Error('Named generic wrapper has extra or incomplete data');
    repairs.push({ kind: 'named_generic_wrapper', tool: namedWrapper[2]!, parameter: 'call' });
    return Decision.parse({ kind: 'tool_call', name: namedWrapper[2], arguments: args.value });
  }
  const attributed = /^<｜｜DSML｜｜\s*calls>\s*<｜｜DSML｜｜\s*invoke name="tool_call_call" name="([A-Za-z_][\w-]*)" arguments="(?=\{)/.exec(text);
  if (attributed) {
    if ((request.tools ?? []).some(tool => tool.function.name === 'tool_call_call'))
      throw new Error('Attributed call wrapper conflicts with a supplied tool');
    const args = objectRange(text, attributed[0].length);
    if (!/^\s*<\/｜｜DSML｜｜\s*parameter>\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*calls>\s*$/.test(text.slice(args.end)))
      throw new Error('Attributed call envelope has extra or incomplete closing data');
    repairs.push({ kind: 'attributed_call_envelope', tool: attributed[1]!, parameter: 'call' });
    return Decision.parse({ kind: 'tool_call', name: attributed[1], arguments: args.value });
  }
  const wrappedCalls = /<｜｜DSML｜｜\s*parameter\s+name="calls"[^>]*>([\s\S]*?)(?:<\/｜｜DSML｜｜\s*parameter\s*>|$)/.exec(text);
  if (wrappedCalls) {
    // A root calls array cannot replace an earlier explicit invocation.
    // Reject mixed envelopes as a whole instead of silently dropping calls.
    if (!/^<｜｜DSML｜｜\s*(?:calls|tool_calls)>\s*(?:<｜｜DSML｜｜\s*invoke\s+name="tool_calls">\s*)?$/.test(text.slice(0, wrappedCalls.index)))
      throw new Error('Mixed DSML calls envelope would discard an earlier invocation');
    const close = /^\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(
      text.slice(wrappedCalls.index + wrappedCalls[0].length));
    // Only an explicit wrapper with all three closing tags can delimit a
    // calls array whose final ']' was omitted. Reuse the existing EOF rule
    // for complete call objects; incomplete arguments or later calls fail.
    const completeEnvelope = Boolean(close && close[1] === marker?.[1] &&
      /^<｜｜DSML｜｜\s*(?:calls|tool_calls)>\s*<｜｜DSML｜｜\s*invoke\s+name="tool_calls">\s*$/.test(text.slice(0, wrappedCalls.index)) &&
      /^<｜｜DSML｜｜\s*parameter\s+name="calls"\s+string="false"\s*>/.test(wrappedCalls[0]) &&
      /<\/｜｜DSML｜｜\s*parameter\s*>$/.test(wrappedCalls[0]));
    const raw = callsArray(wrappedCalls[1]!.trim(), repairs, completeEnvelope) as unknown;
    if (!Array.isArray(raw) || !raw.length) throw new Error('DSML calls parameter is empty or invalid');
    const calls = raw.map(item => {
      if (!item || typeof item !== 'object') throw new Error('DSML tool call is invalid');
      const entry = item as { name?: unknown; arguments?: unknown };
      return { name: entry.name,
        arguments: typeof entry.arguments === 'string' ? parseJson(entry.arguments) : entry.arguments };
    });
    return Decision.parse(calls.length === 1 ? { kind: 'tool_call', ...calls[0] } :
      { kind: 'tool_calls', calls });
  }
  const inlineCalls = /<｜｜DSML｜｜\s*invoke\s+name="tool_calls"[^>]*>\s*\[/.exec(text);
  if (inlineCalls) {
    const raw = arrayAt(text, text.indexOf('[', inlineCalls.index)) as unknown;
    if (!Array.isArray(raw) || !raw.length) throw new Error('DSML inline calls are empty or invalid');
    const calls = raw.map(item => {
      if (!item || typeof item !== 'object') throw new Error('DSML tool call is invalid');
      const entry = item as { name?: unknown; arguments?: unknown };
      return { name: entry.name,
        arguments: typeof entry.arguments === 'string' ? parseJson(entry.arguments) : entry.arguments };
    });
    return Decision.parse(calls.length === 1 ? { kind: 'tool_call', ...calls[0] } :
      { kind: 'tool_calls', calls });
  }
  const calls = [...text.matchAll(/<｜｜DSML｜｜\s*invoke\s+name="([^"]+)">/g)];
  if (!calls.length) {
    const tail = text.slice(marker![0].length);
    if (/^\s*<｜｜DSML｜｜\s*parameter\s+name="name"/.test(tail)) {
      const restored = unwrappedCalls(tail, repairs, request);
      return Decision.parse(restored.length === 1 ? { kind: 'tool_call', ...restored[0] } : { kind: 'tool_calls', calls: restored });
    }
    const bare = /<｜｜DSML｜｜\s*parameter\s+name="arguments"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>\s*<｜｜DSML｜｜\s*parameter\s+name="name"\s*:\s*"([^"]+)"\s*\}/.exec(text);
    if (bare) return Decision.parse({ kind: 'tool_call', name: bare[2],
      arguments: objectAt(bare[1]!, bare[1]!.indexOf('{')) });
    throw new Error('DSML contains no tool calls');
  }
  const parsed: Array<{ name: string; arguments: unknown }> = [];
  for (const [index, call] of calls.entries()) {
  const span = text.slice(call.index, calls[index + 1]?.index ?? text.length);
  const end = invocationEnd(span);
  const fragment = repairParameterMarkers(end === null ? span : span.slice(0, end),
    call[1]!, request, repairs);
  const fields = [...fragment.matchAll(/<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?=<\/｜｜DSML｜｜(?:\s+parameter)?\s*>|<｜｜DSML｜｜\s*parameter|$)/g)];
  let name = call[1]!;
  const args: Record<string, unknown> = {};
  const argumentsField = fields.find(field => field[1] === 'arguments');
  if (argumentsField) {
    const start = fragment.indexOf('{', argumentsField.index);
    try { Object.assign(args, objectAt(fragment, start)); }
    catch (original) {
      const suffix = fragment.slice(argumentsField.index! + argumentsField[0].length);
      if (!/^<\/｜｜DSML｜｜\s*parameter\s*>/.test(suffix)) throw original;
      Object.assign(args, encodedArguments(argumentsField[3]!.trim(), name, request, repairs, 'packed_content_quotes'));
    }
  } else {
    const malformedArguments = /<｜｜DSML｜｜\s*parameter\s+name="arguments"\s*:/.exec(fragment);
    if (malformedArguments) Object.assign(args, objectAt(fragment, fragment.indexOf('{', malformedArguments.index)));
    else for (const field of fields) {
      const fieldName = field[1]!;
      const raw = field[3] ?? '';
      if (name === 'tool_call' && fieldName === 'name') { name = raw.trim(); continue; }
      const schema = request.tools?.find(tool => tool.function.name === name)?.function.parameters as
        { properties?: Record<string, unknown> } | undefined;
      if (fieldName === 'name' && raw.trim() === name && schema?.properties && !Object.hasOwn(schema.properties, 'name')) {
        repairs.push({ kind: 'redundant_tool_name', tool: name, parameter: 'name' });
        continue;
      }
      const stringFlag = /\bstring="(true|false)"/.exec(field[2] ?? '')?.[1];
      const property = schema?.properties?.[fieldName] as { type?: unknown } | undefined;
      const isString = stringFlag === 'true' || (!stringFlag && property?.type === 'string');
      let value: unknown;
      if (isString) value = raw;
      else {
        try { value = parseJson(raw.trim()); }
        catch { value = raw.trim(); }
      }
      if (Object.hasOwn(args, fieldName)) {
        if (!isDeepStrictEqual(args[fieldName], value)) throw new Error(`Duplicate DSML parameter: ${fieldName}`);
        repairs.push({ kind: 'identical_parameter', tool: name, parameter: fieldName });
        continue;
      }
      args[fieldName] = value;
    }
  }
  if (name === 'tool_call') {
    const toolName = fields.find(field => field[1] === 'name')?.[3]?.trim();
    if (!toolName) throw new Error('DSML generic tool_call name is missing');
    name = toolName;
  }
  parsed.push({ name, arguments: args });
  if (end !== null) parsed.push(...unwrappedCalls(span.slice(end), repairs, request, call[1]!));
  }
  return Decision.parse(parsed.length === 1 ? { kind: 'tool_call', ...parsed[0] } :
    { kind: 'tool_calls', calls: parsed });
}
function plainWriteParametersDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const start = /^<｜｜DSML｜｜\s*(calls|tool_calls)>\s*<｜｜DSML｜｜\s*invoke name="write">\s*(?=<parameter\b)/.exec(text);
  if (!start) return null;
  const provided = request.tools?.filter(tool => tool.function.name === 'write') ?? [];
  const schema = provided.length === 1 ? provided[0]!.function.parameters as
    { properties?: Record<string, { type?: unknown }> } | undefined : undefined;
  if (schema?.properties?.file_path?.type !== 'string' || schema.properties.content?.type !== 'string')
    throw new Error('Plain write parameters require one supplied tool with declared string fields');
  let cursor = start[0].length;
  const args: Record<string, unknown> = {};
  for (const name of ['file_path', 'content']) {
    const opening = `<parameter name="${name}">`;
    if (!text.startsWith(opening, cursor)) throw new Error(`Plain write parameter is missing or out of order: ${name}`);
    cursor += opening.length;
    const end = text.indexOf('</parameter>', cursor);
    if (end < 0) throw new Error(`Plain write parameter is incomplete: ${name}`);
    // These fields are strings in the supplied schema. Keep every byte;
    // JSON/XML-looking text in their values must never become another call.
    args[name] = text.slice(cursor, end);
    cursor = end + '</parameter>'.length;
    cursor += /^\s*/.exec(text.slice(cursor))![0].length;
  }
  // The recorded mixed envelope has one plain invoke close followed by
  // empty DSML parameter/invoke closes. Require this entire exact suffix;
  // never finish a value, discard another call, or scan past a field close.
  const tail = /^<\/invoke>\s*<\/｜｜DSML｜｜\s*parameter>\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(text.slice(cursor));
  if (!tail || tail[1] !== start[1]) throw new Error('Plain write envelope has extra or incomplete closing data');
  repairs.push({ kind: 'plain_write_parameters', tool: 'write', parameter: 'arguments' });
  return Decision.parse({ kind: 'tool_call', name: 'write', arguments: args });
}
function genericShorthandNameDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const start = /<｜｜DSML｜｜\s*(calls|tool_calls)>\s*<｜｜DSML｜｜\s*invoke\s+name="tool_call">\s*<｜｜DSML｜｜\s*parameter\s+name="arguments"\s+string="false">\s*/.exec(text);
  if (!start || /｜｜(?:DSML|DS)｜｜|<\/?custom_tool_call\b/.test(text.slice(0, start.index))) return null;
  let args: ReturnType<typeof objectRange>;
  try { args = objectRange(text, start.index + start[0].length); }
  catch { return null; } // Let the normal parser reject malformed arguments.
  const tail = text.slice(args.end);
  if (!/^\s*<\/｜｜DSML｜｜\s*parameter>\s*<｜｜DSML｜｜\s*name(?:"|=)/.test(tail)) return null;
  // The name is an explicit, separately closed field after an entire JSON
  // arguments object. Do not scan or rewrite any protocol text inside args.
  const name = /^\s*<\/｜｜DSML｜｜\s*parameter>\s*<｜｜DSML｜｜\s*name"\s+string="true">([A-Za-z_][\w.-]*)<\/｜｜DSML｜｜\s*parameter>\s*(?:<\/｜｜DSML｜｜\s*invoke>\s*)?<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(tail) ??
    /^\s*<\/｜｜DSML｜｜\s*parameter>\s*<｜｜DSML｜｜\s*name="([A-Za-z_][\w.-]*)"｜｜DSML｜｜\s*parameter>\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(tail);
  if (!name || name[2] !== start[1]) throw new Error('Generic DSML shorthand name has extra or incomplete boundaries');
  if (request.tools?.some(tool => tool.function.name === 'tool_call'))
    throw new Error('Generic DSML wrapper conflicts with a supplied tool');
  if ((request.tools?.filter(tool => tool.function.name === name[1]) ?? []).length !== 1)
    throw new Error(`Unknown or ambiguous DSML tool: ${diagnosticToolName(name[1]!)}`);
  const decision = Decision.parse({ kind: 'tool_call', name: name[1], arguments: args.value });
  repairs.push({ kind: 'generic_shorthand_name', tool: name[1]!, parameter: 'name' });
  return decision;
}
function callsParameterDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const start = /<｜｜DSML｜｜\s*parameter\s+name="calls"[^>]*>/.exec(text);
  if (!start || /｜｜(?:DSML|DS)｜｜|<\/?custom_tool_call\b/.test(text.slice(0, start.index))) return null;
  if (!/^<｜｜DSML｜｜\s*parameter\s+name="calls"\s+string="false"\s*>$/.test(start[0]))
    throw new Error('Unwrapped DSML calls parameter must contain an explicit JSON array');
  let at = start.index + start[0].length;
  while (at < text.length && /\s/.test(text[at]!)) at++;
  const array = arrayRange(text, at);
  // Both open wrappers were omitted, but their complete closing boundaries
  // remain. Parse the entire array before inspecting tags so protocol-looking
  // strings inside arguments stay data. Never close a truncated array or call.
  if (!/^\s*<\/｜｜DSML｜｜\s*parameter>\s*<\/｜｜DSML｜｜\s*invoke>\s*<\/｜｜DSML｜｜\s*(?:calls|tool_calls)>\s*$/.test(text.slice(array.end)))
    throw new Error('Unwrapped DSML calls parameter has extra or incomplete closing data');
  const decision = decisionObject({ kind: 'tool_calls', calls: array.value }, request, repairs);
  if (decision.kind !== 'tool_calls') throw new Error('Unwrapped DSML calls parameter is invalid');
  repairs.push({ kind: 'missing_calls_parameter_wrapper', tool: 'wrapper', parameter: 'calls' });
  return decision.calls.length === 1 ? { kind: 'tool_call', ...decision.calls[0]! } : decision;
}
function missingCallsOpener(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision | null {
  const start = /<｜｜DSML｜｜\s*invoke\s+name="([A-Za-z_][\w.-]*)">/.exec(text);
  if (!start) return null;
  if (/｜｜(?:DSML|DS)｜｜|<\/?custom_tool_call\b/.test(text.slice(0, start.index)))
    throw new Error('Unexpected protocol data before DSML invocation');
  const fragment = text.slice(start.index);
  const end = invocationEnd(fragment);
  // Only the outer opener was lost in the recorded response. Require one
  // complete invoke and its explicit outer close; never finish a parameter,
  // discard a later call, or reinterpret JSON examples inside string values.
  const outer = end === null ? null : /^\s*<\/｜｜DSML｜｜\s*(calls|tool_calls)>\s*$/.exec(fragment.slice(end));
  if (!outer) throw new Error('DSML invocation without its opener must have complete single-call boundaries');
  const provided = request.tools?.filter(tool => tool.function.name === start[1]) ?? [];
  if (provided.length !== 1) throw new Error(`Unknown or ambiguous DSML tool: ${diagnosticToolName(start[1]!)}`);
  const decision = dsmlDecision(`<｜｜DSML｜｜ ${outer[1]}>${fragment}`, request, repairs);
  if (decision?.kind !== 'tool_call' || decision.name !== start[1])
    throw new Error('DSML invocation without its opener is ambiguous');
  repairs.push({ kind: 'missing_calls_opener', tool: start[1]!, parameter: 'calls' });
  return decision;
}
function encodedArguments(source: string, tool: string, request: ChatRequest, repairs: DecisionRepair[],
  repairKind: 'encoded_content_quotes' | 'packed_content_quotes' = 'encoded_content_quotes'): unknown {
  try { return parseJson(source); }
  catch (original) {
    const schema = request.tools?.find(entry => entry.function.name === tool)?.function.parameters as
      { properties?: Record<string, { type?: unknown }> } | undefined;
    if (tool !== 'write' || schema?.properties?.file_path?.type !== 'string' || schema.properties.content?.type !== 'string') throw original;
    // Observed inner JSON has exactly file_path then a final content string.
    // Its code quotes are underescaped, while the JSON escapes are intact.
    const match = /^(\s*\{\s*"file_path"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"content"\s*:\s*")([\s\S]*)("\s*\}\s*)(\}\s*)?$/.exec(source);
    if (!match || (match[4] && repairKind !== 'packed_content_quotes')) throw original;
    const body = match[2]!;
    // A possible following object field makes the final-string boundary ambiguous.
    if (/"\s*,\s*"(?:[^"\\]|\\.)*"\s*:/.test(body)) throw original;
    let escaped = false; let corrected = ''; let changes = 0;
    for (const char of body) {
      if (escaped) { escaped = false; corrected += char; }
      else if (char === '\\') { escaped = true; corrected += char; }
      else if (char === '"') { corrected += '\\"'; changes++; }
      else corrected += char;
    }
    if (!changes || escaped) throw original;
    const decoded = parseJson(`${match[1]}${corrected}${match[3]}`);
    repairs.push({ kind: repairKind, tool, parameter: 'content' });
    if (match[4]) repairs.push({ kind: 'arguments_wrapper_close', tool, parameter: 'arguments' });
    return decoded;
  }
}
function decisionObject(value: unknown, request: ChatRequest, repairs: DecisionRepair[]): Decision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Decision.parse(value);
  let row = value as Record<string, unknown>;
  const recovered: DecisionRepair[] = [];
  if (!Object.hasOwn(row, 'kind') && Object.keys(row).length === 1 && Array.isArray(row.tool_calls) && row.tool_calls.length) {
    row = { kind: 'tool_calls', calls: row.tool_calls };
    recovered.push({ kind: 'tool_calls_envelope', tool: 'wrapper', parameter: 'tool_calls' });
  }
  if (typeof row.kind === 'string' && !['final', 'tool_call', 'tool_calls'].includes(row.kind)) {
    const provided = request.tools?.filter(tool => tool.function.name === row.kind) ?? [];
    const schema = provided.length === 1 ? provided[0]!.function.parameters as
      { properties?: Record<string, unknown> } | undefined : undefined;
    const keys = Object.keys(row).filter(key => key !== 'kind');
    // This observed form explicitly uses a provided tool as the discriminator.
    // It can carry declared flat fields or one complete arguments object.
    // Never unwrap a tool's own parameter named arguments or mix both forms.
    const packed = keys.length === 1 && keys[0] === 'arguments' && schema?.properties &&
      !Object.hasOwn(schema.properties, 'arguments') && row.arguments !== null &&
      typeof row.arguments === 'object' && !Array.isArray(row.arguments);
    if (schema?.properties && !Object.hasOwn(schema.properties, 'kind') &&
      (packed || keys.every(key => Object.hasOwn(schema.properties!, key)))) {
      const name = row.kind;
      row = { kind: 'tool_call', name, arguments: packed ? row.arguments : Object.fromEntries(keys.map(key => [key, row[key]])) };
      recovered.push({ kind: 'flat_tool_kind', tool: name, parameter: 'kind' });
    }
  }
  const normalizeCall = (call: unknown, root = false): unknown => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return call;
    const item = call as Record<string, unknown>;
    if (!Object.hasOwn(item, 'arguments') && typeof item.name === 'string') {
      const provided = request.tools?.filter(tool => tool.function.name === item.name) ?? [];
      const schema = provided.length === 1 ? provided[0]!.function.parameters as
        { properties?: Record<string, unknown> } | undefined : undefined;
      const keys = Object.keys(item).filter(key => key !== 'name' && (!root || key !== 'kind'));
      if (schema?.properties && !Object.hasOwn(schema.properties, 'name') &&
          (!root || !Object.hasOwn(schema.properties, 'kind')) && keys.every(key => Object.hasOwn(schema.properties!, key))) {
        recovered.push({ kind: 'flat_call_arguments', tool: item.name, parameter: 'arguments' });
        return { ...(root ? { kind: item.kind } : {}), name: item.name,
          arguments: Object.fromEntries(keys.map(key => [key, item[key]])) };
      }
    }
    if (typeof item.arguments !== 'string') return item;
    const args = encodedArguments(item.arguments, typeof item.name === 'string' ? item.name : 'unknown', request, recovered);
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Encoded tool arguments must decode to a JSON object');
    recovered.push({ kind: 'encoded_arguments', tool: typeof item.name === 'string' ? item.name : 'unknown', parameter: 'arguments' });
    return { ...item, arguments: args };
  };
  const normalized = row.kind === 'tool_call' ? normalizeCall(row, true)
    : row.kind === 'tool_calls' && Array.isArray(row.calls) ? { ...row, calls: row.calls.map(call => normalizeCall(call)) } : row;
  const decision = Decision.parse(normalized);
  repairs.push(...recovered);
  return decision;
}
function missingCallClosures(text: string): { value: unknown; repairs: DecisionRepair[] } | null {
  const header = /^\s*\{\s*"kind"\s*:\s*"tool_calls"\s*,\s*"calls"\s*:\s*\[/.exec(text);
  if (!header) return null;
  try {
    let cursor = header[0].length;
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const repairs: DecisionRepair[] = [];
    const space = () => { while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++; };
    while (true) {
      space();
      const call = /^\{\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"arguments"\s*:\s*/.exec(text.slice(cursor));
      if (!call) return null;
      const name = parseJson(call[1]!) as string;
      cursor += call[0].length;
      // Only an entire valid object is recoverable; never close incomplete
      // arguments or drop a later call to make the batch look complete.
      const args = objectRange(text, cursor);
      calls.push({ name, arguments: args.value });
      cursor = args.end;
      space();
      let closedCall = false;
      if (text[cursor] === '}') { closedCall = true; cursor++; space(); }
      else if (text[cursor] === ',' || text[cursor] === ']')
        repairs.push({ kind: 'call_wrapper_close', tool: name, parameter: 'call' });
      else return null;
      if (text[cursor] === ',') { cursor++; continue; }
      // Only complete call objects at EOF, or an explicit completed calls
      // array, can lack the final decision wrapper. Never finish arguments.
      if ((cursor === text.length && closedCall) || /^\]\s*$/.test(text.slice(cursor))) {
        repairs.push({ kind: 'decision_wrapper_close', tool: name, parameter: 'calls' });
        return { value: { kind: 'tool_calls', calls }, repairs };
      }
      const tail = text.slice(cursor);
      // Observed output omits a call's close and then repeats the array/root
      // closing pair. Every arguments object above must already be complete;
      // tolerate only this exact empty tail, never another call or any data.
      const duplicatedClosers = /^\]\s*\}\s*\]\s*\}\s*$/.test(tail);
      if ((!/^\]\s*\}\s*$/.test(tail) && !duplicatedClosers) || !repairs.length) return null;
      if (duplicatedClosers) repairs.push({ kind: 'redundant_decision_closers', tool: name, parameter: 'calls' });
      return { value: { kind: 'tool_calls', calls }, repairs };
    }
  } catch { return null; }
}
function jsonDecision(text: string, request: ChatRequest, repairs: DecisionRepair[]): Decision {
  const custom = /^<custom_tool_call>\s*([\s\S]*?)\s*<\/custom_tool_call>$/.exec(text);
  if (custom) {
    const inner = parseJson(custom[1]!) as Record<string, unknown>;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) ||
        Object.keys(inner).length !== 2 || !Object.hasOwn(inner, 'name') || !Object.hasOwn(inner, 'arguments'))
      throw new Error('Custom tool envelope must have only explicit name and complete arguments');
    const decision = decisionObject({ kind: 'tool_call', name: inner.name, arguments: inner.arguments }, request, repairs);
    repairs.push({ kind: 'custom_tool_envelope', tool: String(inner.name), parameter: 'call' });
    return decision;
  }
  // An observed plain XML envelope carries a complete explicit tool name
  // and JSON arguments. Accept only this entire single-call representation;
  // incomplete envelopes and extra calls must never turn into final prose.
  if (/(?:^|\n)[\t ]*<\/?tool_call\b/.test(text)) {
    const plain = /^<tool_call>\s*<parameter name="name">([^<>]+)<\/parameter>\s*<parameter name="arguments">([\s\S]+)<\/parameter>\s*<\/tool_call>$/.exec(text);
    if (!plain) throw new Error('Plain tool envelope requires one complete name and arguments pair');
    const name = plain[1]!.trim();
    const decision = decisionObject({ kind: 'tool_call', name, arguments: parseJson(plain[2]!) }, request, repairs);
    repairs.push({ kind: 'plain_tool_envelope', tool: name, parameter: 'call' });
    return decision;
  }
  let decoded: unknown;
  try { decoded = parseJson(text); }
  catch (original) {
    const stub = /,"}}\s*$/.exec(text);
    if (stub) {
      let quoted = false, escaped = false;
      for (const char of text.slice(0, stub.index)) {
        if (escaped) escaped = false;
        else if (char === '\\' && quoted) escaped = true;
        else if (char === '"') quoted = !quoted;
      }
      if (!quoted && !escaped) {
        const restored = parseJson(text.slice(0, stub.index) + '}}') as Record<string, unknown>;
        const args = restored?.arguments as Record<string, unknown> | undefined;
        const provided = request.tools?.filter(tool => tool.function.name === 'edit') ?? [];
        const schema = provided.length === 1 ? provided[0]!.function.parameters as
          { properties?: Record<string, { type?: unknown }> } : undefined;
        const names = ['file_path', 'old_string', 'new_string'];
        if (restored.kind === 'tool_call' && restored.name === 'edit' && args && Object.keys(args).length === 3 &&
            names.every(name => typeof args[name] === 'string' && schema?.properties?.[name]?.type === 'string')) {
          const decision = decisionObject(restored, request, repairs);
          repairs.push({ kind: 'terminal_field_stub', tool: 'edit', parameter: 'arguments' });
          return decision;
        }
      }
    }
    const decorated = /^<\{\*\*tool_calls\*\*:\s*/.exec(text);
    if (decorated) {
      const complete = arrayRange(text, decorated[0].length);
      if (!/^(?:\s|<?<\/?｜｜DSML｜｜\s*parameter\s*>)*$/.test(text.slice(complete.end))) throw original;
      const decision = decisionObject({ kind: 'tool_calls', calls: complete.value }, request, repairs);
      repairs.push({ kind: 'decorated_calls_envelope', tool: 'wrapper', parameter: 'tool_calls' });
      return decision;
    }
    const restored = missingCallClosures(text);
    if (restored) {
      const decision = decisionObject(restored.value, request, repairs);
      repairs.push(...restored.repairs);
      return decision;
    }
    let candidate: Decision | null = null;
    let candidateRepairs: DecisionRepair[] = [];
    const starts = [...text.matchAll(/\{\s*"kind"\s*:\s*"(?:tool_calls|tool_call|final)"/g)];
    for (const start of starts) {
      try {
        const recovered: DecisionRepair[] = [];
        candidate = decisionObject(objectAt(text, start.index), request, recovered);
        candidateRepairs = recovered;
      }
      catch { /* Continue to a later complete decision block. */ }
    }
    if (candidate) { repairs.push(...candidateRepairs); return candidate; }
    // Qoder occasionally writes the array/object as the value of "kind". Recover
    // these two exact wrappers, then run the usual tool-name and schema checks.
    const callsWrapper = /^\{\s*"kind"\s*:\s*"tool_calls"\s*:\s*\[/.exec(text);
    if (callsWrapper) {
      const corrected = text.replace(callsWrapper[0], '{"kind":"tool_calls","calls":[');
      return decisionObject(parseJson(corrected), request, repairs);
    }
    const callWrapper = /^\{\s*"kind"\s*:\s*"tool_call"\s*:\s*\{/.exec(text);
    if (callWrapper) {
      const inner = objectAt(text, text.indexOf('{', callWrapper[0].length - 1));
      return decisionObject({ kind: 'tool_call', ...(inner as object) }, request, repairs);
    }
    // A plain assistant reply is a valid final answer. Never reinterpret a malformed
    // structured tool decision as prose, since that could hide an intended tool call.
    if (text && !text.startsWith('{') && !text.startsWith('[') &&
      !/｜｜(?:DSML|DS)｜｜/.test(text) && !/<\/?custom_tool_call\b/.test(text) && !/"kind"\s*:/.test(text))
      return { kind: 'final', content: text };
    throw original;
  }
  return decisionObject(decoded, request, repairs);
}
export function parseDecision(text: string, request: ChatRequest, onRepair?: (repair: DecisionRepair) => void): Decision {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  // This observed alternate marker is not a supported envelope. Reject it
  // before a partial call or plain-text final can hide unexecuted tool intent.
  // A leading JSON object/array owns its strings, including markup examples.
  if (!/^[{[]/.test(source) &&
      /(?:^|\n)[\t ]*<\/?｟DSML｠+[\t ]*(?:calls|tool_calls|invoke|parameter)\b/.test(source))
    throw new Error('Malformed DSML tool envelope: unsupported marker');
  const repairs: DecisionRepair[] = [];
  const jsonAt = source.search(/\{\s*"kind"\s*:\s*"(?:tool_calls|tool_call|final)"/);
  const dsmlAt = source.search(/<｜｜DSML｜｜\s*(?:calls|tool_calls)>|<｜｜DSML｜｜\s*(?:invoke\s+name="|parameter\s+name="calls")|<｜｜(?:DS|DSML)｜｜\s*tool_calls\s*｜｜(?:DS|DSML)｜｜/);
  // Protocol markers inside a JSON string are data. Select the outer
  // representation before scanning the richer DSML forms.
  const jsonOuter = /^[{[]/.test(source) || (jsonAt >= 0 && (dsmlAt < 0 || jsonAt < dsmlAt));
  let decision: Decision;
  try { decision = jsonOuter ? jsonDecision(source, request, repairs)
    : plainWriteParametersDecision(source, request, repairs) ?? callsParameterDecision(source, request, repairs) ?? genericShorthandNameDecision(source, request, repairs) ??
      alternateDsDecision(source, request, repairs) ?? dsmlDecision(source, request, repairs) ??
      missingCallsOpener(source, request, repairs) ?? jsonDecision(source, request, repairs); }
  catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues.slice(0, 3).map(issue =>
        `${issue.path.join('.') || 'decision'}: ${issue.message}`).join('; ');
      throw new Error(`Decision shape invalid: ${detail}`);
    }
    throw error;
  }
  const names = request.tools?.map(t => t.function.name) ?? [];
  const selected = typeof request.tool_choice === 'object' && request.tool_choice !== null &&
    'function' in request.tool_choice ? (request.tool_choice.function as { name?: unknown })?.name : undefined;
  if (decision.kind === 'final') {
    if (request.tool_choice === 'required' || typeof selected === 'string') throw new Error('tool_choice requires a tool call');
    return decision;
  }
  if (request.tool_choice === 'none') throw new Error('tool_choice forbids tool calls');
  const calls = decision.kind === 'tool_call' ? [decision] : decision.calls;
  for (const call of calls) {
    if (!names.includes(call.name) || (typeof selected === 'string' && selected !== call.name))
      throw new Error(`Unknown or unselected tool name: ${diagnosticToolName(call.name)}`);
    const schema = request.tools?.find(t => t.function.name === call.name)?.function.parameters;
    if (typeof schema === 'boolean' || (schema && typeof schema === 'object')) {
      const validate = toolValidator(schema);
      if (!validate(call.arguments)) {
        const detail = (validate.errors ?? []).slice(0, 2).map(error =>
          `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ');
        throw new Error(`Arguments for ${call.name} violate its schema${detail ? `: ${detail}` : ''}`);
      }
    }
  }
  for (const repair of repairs) onRepair?.(repair);
  return decision;
}
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      throw new Error('Unsupported non-text message content');
    }).join('\n');
  }
  throw new Error('Unsupported message content');
}
export function assertTextRequest(request: ChatRequest) {
  for (const message of request.messages) contentText(message.content);
}
function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const candidate = text.slice(0, limit);
  const breakAt = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('。'));
  return `${candidate.slice(0, breakAt >= limit / 2 ? breakAt + 1 : limit).trimEnd()}…`;
}
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'description' && typeof item === 'string' ? shorten(item, 160) : compactSchema(item),
  ]));
}
export function toolDefinitions(request: ChatRequest, full = false) {
  return (request.tools ?? []).map(t => ({ name: t.function.name,
    description: full ? t.function.description ?? '' : shorten(t.function.description ?? '', 320),
    parameters: full ? t.function.parameters ?? { type: 'object' } :
      compactSchema(t.function.parameters ?? { type: 'object' }) }));
}
export function conversationPrompt(request: ChatRequest, options: {
  omitUnchangedTools?: boolean; historyMode?: 'full' | 'delta'; fullToolDetails?: boolean;
} = {}): string {
  const messages = request.messages;
  const transcript = messages.map(m => ({ role: m.role, content: contentText(m.content),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
  }));
  const tools = toolDefinitions(request, options.fullToolDetails);
  const toolBlock = options.omitUnchangedTools
    ? `Tool definitions are unchanged from the previous turn in this Qoder session. Use those exact names and schemas.\n`
    : `Tools (JSON schemas): ${JSON.stringify(tools)}\n`;
  return `You are the model decision layer for DeepSeek Harness. The Harness itself owns and executes all tools.\n` +
    `Return exactly one JSON object, with no markdown:\n` +
    `{"kind":"final","content":"your response"}\n` +
    `or {"kind":"tool_call","name":"one provided tool name","arguments":{...}}\n` +
    `For independent parallel actions, you may use {"kind":"tool_calls","calls":[{"name":"provided tool name","arguments":{...}}]}.\n` +
    `Choose a tool when the user task needs a file, command, search, or other host action.\n` +
    `Do not return a progress-only final answer while host actions remain necessary.\n` +
    `For long write/edit content, issue one tool call at a time instead of batching large file edits. ` +
    `For edit, use the smallest unambiguous matching old_string instead of copying a whole file.\n` +
    `Protocol check before sending: use JSON only, never DSML/XML or positional argument arrays. ` +
    `Every required field must be present; use the schema's actual types (numbers are not quoted). ` +
    `For read use named file_path/offset/limit when declared; for edit include complete old_string AND new_string; ` +
    `for pwsh include its required description AND command. Finish every string/object before ending the response.\n` +
    `Tool choice: ${JSON.stringify(request.tool_choice ?? 'auto')}\n` +
    toolBlock +
    `Conversation (${options.historyMode === 'delta' ? 'new messages since the prior decision' : 'full history'}): ${JSON.stringify(transcript)}\n` +
    `Assistant decision:`;
}
export function completion(request: ChatRequest, decision: Decision, identity: string = randomUUID()) {
  const id = `chatcmpl-${identity}`;
  const calls = decision.kind === 'final' ? [] : decision.kind === 'tool_call' ? [decision] : decision.calls;
  const message = decision.kind === 'final' ? { role: 'assistant', content: decision.content } : {
    role: 'assistant', content: null, tool_calls: calls.map((call,index) => ({
      id: `call_${createHash('sha256').update(`${identity}:${index}`).digest('hex').slice(0, 32)}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
  return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model,
    choices: [{ index: 0, message, finish_reason: decision.kind === 'final' ? 'stop' : 'tool_calls' }] };
}
export function chunks(result: ReturnType<typeof completion>) {
  const choice = result.choices[0]!;
  const base = { id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model };
  const entries: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }];
  if (choice.finish_reason === 'tool_calls') {
    const calls = 'tool_calls' in choice.message ? choice.message.tool_calls ?? never() : never();
    calls.forEach((call, index) => entries.push({ ...base, choices: [{ index: 0,
      delta: { tool_calls: [{ index, id: call.id, type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments } }] }, finish_reason: null }] }));
  } else {
    entries.push({ ...base, choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }] });
  }
  entries.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] });
  return entries;
}
function never(): never { throw new Error('Missing tool call'); }
