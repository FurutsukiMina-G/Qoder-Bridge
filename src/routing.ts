import type { ChatRequest } from './compat.js';

export function hasConversationPrefix(previous: ChatRequest['messages'], current: ChatRequest['messages']) {
  return current.length >= previous.length &&
    JSON.stringify(current.slice(0, previous.length)) === JSON.stringify(previous);
}

export function routeConversation(
  request: ChatRequest,
  sessions: Map<string, { messages: ChatRequest['messages'] }>,
  byClientSession: Map<string, string>,
  byToolId: Map<string, string>,
): string | undefined {
  const compatible = (id: string | undefined) => {
    const record = id && sessions.get(id);
    return record && hasConversationPrefix(record.messages, request.messages) ? id : undefined;
  };
  if (request.prompt_cache_key) return compatible(byClientSession.get(request.prompt_cache_key));
  for (const message of [...request.messages].reverse()) {
    const ids = [message.tool_call_id, ...((message.tool_calls ?? []) as Array<{ id?: string }>).map(call => call.id)];
    for (const id of ids) if (id) {
      const owner = compatible(byToolId.get(id));
      if (owner) return owner;
    }
  }
  return undefined;
}
