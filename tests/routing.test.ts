import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatRequest } from '../src/compat.js';
import { routeConversation } from '../src/routing.js';

test('explicit Harness keys prevent two sessions with identical tool IDs from sharing Qoder history', () => {
  const base = [{ role: 'user', content: 'read sentinel' }];
  const sessions = new Map([['qoder-a', { messages: ChatRequest.parse({ model: 'x', messages: base }).messages }]]);
  const byClient = new Map([['harness-a', 'qoder-a']]);
  const byTool = new Map([['call_shared', 'qoder-a']]);
  const next = [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_shared', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_shared', content: 'result' }];
  const requestA = ChatRequest.parse({ model: 'x', prompt_cache_key: 'harness-a', messages: [...base, ...next] });
  const requestB = ChatRequest.parse({ model: 'x', prompt_cache_key: 'harness-b', messages: [...base, ...next] });
  assert.equal(routeConversation(requestA, sessions, byClient, byTool), 'qoder-a');
  assert.equal(routeConversation(requestB, sessions, byClient, byTool), undefined);
  const branched = ChatRequest.parse({ model: 'x', prompt_cache_key: 'harness-a',
    messages: [{ role: 'user', content: 'different branch' }, ...next] });
  assert.equal(routeConversation(branched, sessions, byClient, byTool), undefined);
  const legacy = ChatRequest.parse({ model: 'x', messages: [...base, ...next] });
  assert.equal(routeConversation(legacy, sessions, byClient, byTool), 'qoder-a');
});
