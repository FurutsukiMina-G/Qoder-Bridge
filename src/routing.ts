import type { ChatRequest } from './compat.js';
import {conversationMessages} from './compat.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export function hasConversationPrefix(previous: ChatRequest['messages'], current: ChatRequest['messages']) {
  return current.length >= previous.length &&
    isDeepStrictEqual(conversationMessages(current.slice(0, previous.length)),conversationMessages(previous));
}

/** Counts and hashes only: diagnose history resets without retaining another copy of user text. */
export function prefixIssue(previous: ChatRequest['messages'], current: ChatRequest['messages']) {
  const before=conversationMessages(previous),after=conversationMessages(current);
  let at=0;while(at<Math.min(before.length,after.length)&&isDeepStrictEqual(before[at],after[at]))at++;
  if(at===before.length)return null;
  const stamp=(value:unknown)=>value===undefined?null:createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {reason:after.length<before.length?'history_shortened':'history_rewritten',first_changed_index:at,
    previous_message_count:before.length,current_message_count:after.length,
    previous_role:before[at]?.role??null,current_role:after[at]?.role??null,
    previous_sha256:stamp(before[at]),current_sha256:stamp(after[at])};
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
