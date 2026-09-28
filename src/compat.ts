import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { z } from 'zod';

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
const json = new Ajv.default({ allErrors: true, strict: false, validateFormats: false });
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
function objectAt(text: string, start: number): unknown {
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
  return parseJson(text.slice(start, end));
}
function arrayAt(text: string, start: number): unknown {
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
      if (!stack.length) return parseJson(text.slice(start, i + 1));
    }
  }
  throw new Error('Decision JSON array is incomplete');
}
function callsArray(text: string): unknown {
  try { return parseJson(text); }
  catch (original) {
    // Some SDK-formatted call arrays carry an extra closing brace after the
    // complete array. Ignore only unmatched closing delimiters, never prose
    // or another tool call, and validate every recovered call below.
    const end = text.lastIndexOf(']');
    if (end >= 0 && /^[}\]\s]+$/.test(text.slice(end + 1))) {
      const recovered = parseJson(text.slice(0, end + 1));
      if (Array.isArray(recovered)) return recovered;
    }
    throw original;
  }
}
function dsmlDecision(text: string): Decision | null {
  const marker = /<｜｜DSML｜｜\s*(?:calls|tool_calls)>/.exec(text);
  const markerAt = marker?.index ?? -1;
  if (markerAt < 0) return null;
  text = text.slice(markerAt);
  const wrappedCalls = /<｜｜DSML｜｜\s*parameter\s+name="calls"[^>]*>([\s\S]*?)(?:<\/｜｜DSML｜｜\s*parameter\s*>|$)/.exec(text);
  if (wrappedCalls) {
    const raw = callsArray(wrappedCalls[1]!.trim()) as unknown;
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
    const bare = /<｜｜DSML｜｜\s*parameter\s+name="arguments"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>\s*<｜｜DSML｜｜\s*parameter\s+name="name"\s*:\s*"([^"]+)"\s*\}/.exec(text);
    if (bare) return Decision.parse({ kind: 'tool_call', name: bare[2],
      arguments: objectAt(bare[1]!, bare[1]!.indexOf('{')) });
    throw new Error('DSML contains no tool calls');
  }
  const parsed = calls.map((call, index) => {
  const fragment = text.slice(call.index, calls[index + 1]?.index ?? text.length);
  const fields = [...fragment.matchAll(/<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?=<\/｜｜DSML｜｜(?:\s+parameter)?\s*>|<｜｜DSML｜｜\s*parameter|$)/g)];
  let name = call[1]!;
  const args: Record<string, unknown> = {};
  const argumentsField = fields.find(field => field[1] === 'arguments');
  if (argumentsField) {
    const start = fragment.indexOf('{', argumentsField.index);
    Object.assign(args, objectAt(fragment, start));
  } else {
    const malformedArguments = /<｜｜DSML｜｜\s*parameter\s+name="arguments"\s*:/.exec(fragment);
    if (malformedArguments) Object.assign(args, objectAt(fragment, fragment.indexOf('{', malformedArguments.index)));
    else for (const field of fields) {
      const fieldName = field[1]!;
      const raw = field[3] ?? '';
      if (name === 'tool_call' && fieldName === 'name') { name = raw.trim(); continue; }
      const isString = /\bstring="true"/.test(field[2] ?? '');
      if (isString) args[fieldName] = raw;
      else {
        try { args[fieldName] = parseJson(raw.trim()); }
        catch { args[fieldName] = raw.trim(); }
      }
    }
  }
  if (name === 'tool_call') {
    const toolName = fields.find(field => field[1] === 'name')?.[3]?.trim();
    if (!toolName) throw new Error('DSML generic tool_call name is missing');
    name = toolName;
  }
  return { name, arguments: args };
  });
  return Decision.parse(parsed.length === 1 ? { kind: 'tool_call', ...parsed[0] } :
    { kind: 'tool_calls', calls: parsed });
}
function jsonDecision(text: string): Decision {
  let decoded: unknown;
  try { decoded = parseJson(text); }
  catch (original) {
    let candidate: Decision | null = null;
    const starts = [...text.matchAll(/\{\s*"kind"\s*:\s*"(?:tool_calls|tool_call|final)"/g)];
    for (const start of starts) {
      try { candidate = Decision.parse(objectAt(text, start.index)); }
      catch { /* Continue to a later complete decision block. */ }
    }
    if (candidate) return candidate;
    // Qoder occasionally writes the array/object as the value of "kind". Recover
    // these two exact wrappers, then run the usual tool-name and schema checks.
    const callsWrapper = /^\{\s*"kind"\s*:\s*"tool_calls"\s*:\s*\[/.exec(text);
    if (callsWrapper) {
      const corrected = text.replace(callsWrapper[0], '{"kind":"tool_calls","calls":[');
      return Decision.parse(parseJson(corrected));
    }
    const callWrapper = /^\{\s*"kind"\s*:\s*"tool_call"\s*:\s*\{/.exec(text);
    if (callWrapper) {
      const inner = objectAt(text, text.indexOf('{', callWrapper[0].length - 1));
      return Decision.parse({ kind: 'tool_call', ...(inner as object) });
    }
    // A plain assistant reply is a valid final answer. Never reinterpret a malformed
    // structured tool decision as prose, since that could hide an intended tool call.
    if (text && !text.startsWith('{') && !text.startsWith('[') &&
      !text.includes('<｜｜DSML｜｜') && !/"kind"\s*:/.test(text))
      return { kind: 'final', content: text };
    throw original;
  }
  return Decision.parse(decoded);
}
export function parseDecision(text: string, request: ChatRequest): Decision {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const source = fenced?.[1] ?? trimmed;
  let decision: Decision;
  try { decision = dsmlDecision(source) ?? jsonDecision(source); }
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
      throw new Error(`Unknown or unselected tool name: ${call.name}`);
    const schema = request.tools?.find(t => t.function.name === call.name)?.function.parameters;
    if (schema && typeof schema === 'object') {
      const validate = json.compile(schema);
      if (!validate(call.arguments)) {
        const detail = (validate.errors ?? []).slice(0, 2).map(error =>
          `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ');
        throw new Error(`Arguments for ${call.name} violate its schema${detail ? `: ${detail}` : ''}`);
      }
    }
  }
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
    `Tool choice: ${JSON.stringify(request.tool_choice ?? 'auto')}\n` +
    toolBlock +
    `Conversation (${options.historyMode === 'delta' ? 'new messages since the prior decision' : 'full history'}): ${JSON.stringify(transcript)}\n` +
    `Assistant decision:`;
}
export function completion(request: ChatRequest, decision: Decision) {
  const id = `chatcmpl-${randomUUID()}`;
  const calls = decision.kind === 'final' ? [] : decision.kind === 'tool_call' ? [decision] : decision.calls;
  const message = decision.kind === 'final' ? { role: 'assistant', content: decision.content } : {
    role: 'assistant', content: null, tool_calls: calls.map(call => ({
      id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
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
