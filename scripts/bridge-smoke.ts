import { readFile } from 'node:fs/promises';
import { PUBLIC_MODEL } from '../src/server.js';
const key = (await readFile('.runtime/bridge-key', 'utf8')).trim();
const url = 'http://127.0.0.1:8646/v1/chat/completions';
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file through the host',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
async function request(payload: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Bridge HTTP ${response.status}: ${raw}`);
  return JSON.parse(raw);
}
const first = await request({ model: PUBLIC_MODEL, messages: [{ role: 'user', content: 'Use read_file to read sentinel.txt.' }], tools, tool_choice: 'required', stream: false });
const call = first.choices?.[0]?.message?.tool_calls?.[0];
if (!call || call.function.name !== 'read_file' || JSON.parse(call.function.arguments).path !== 'sentinel.txt') throw new Error('Native-shaped tool call was not returned');
const second = await request({ model: PUBLIC_MODEL, messages: [
  { role: 'user', content: 'Use read_file to read sentinel.txt.' },
  { role: 'assistant', content: null, tool_calls: [call] },
  { role: 'tool', tool_call_id: call.id, content: 'SENTINEL_OK' },
], tools, tool_choice: 'none', stream: false });
if (!String(second.choices?.[0]?.message?.content).includes('SENTINEL_OK')) throw new Error('Tool result was not used in final answer');
console.log(JSON.stringify({ first: call.function.name, arguments: JSON.parse(call.function.arguments), second: second.choices[0].message.content }));
