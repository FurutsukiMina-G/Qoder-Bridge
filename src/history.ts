import type { SessionMessage, ContentBlock } from '@qodercn-ai/qodercn-agent-sdk';

export function auditHistory(messages: SessionMessage[], toolIds: string[]) {
  const calls: string[] = [];
  const results: Array<{ tool_use_id: string; is_error: boolean; content: unknown; non_execution_kind: string | null }> = [];
  for (const entry of messages) {
    const message = entry.message as { content?: unknown } | null;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'tool_use' && block.id && toolIds.includes(block.id)) calls.push(block.id);
      if (block.type === 'tool_result' && block.tool_use_id && toolIds.includes(block.tool_use_id)) {
        results.push({ tool_use_id: block.tool_use_id, is_error: block.is_error === true,
          content: block.content ?? null,
          non_execution_kind: entry.tool_result_meta?.find(m => m.id === block.tool_use_id)?.non_execution_kind ?? null });
      }
    }
  }
  const duplicated = toolIds.some(id => results.filter(r => r.tool_use_id === id).length > 1);
  const contaminated = duplicated || results.some(r => r.is_error || r.non_execution_kind !== null);
  return {
    message_count: messages.length, matched_tool_calls: calls, tool_results: results,
    duplicated_tool_result: duplicated,
    session_history_clean: !messages.length || !toolIds.length || toolIds.some(id => !calls.includes(id))
      ? 'not_verified' : contaminated ? 'failed' : 'no_contamination_observed',
  };
}
