/** Recognize generated call envelopes, not XML examples embedded in ordinary explanations. */
export function isToolProtocolText(text: string): boolean {
  const source = text.trim().replace(/^```(?:xml|json|text)?\s*\n([\s\S]*?)\n```$/i, '$1').trimStart();
  return /^(?:<\/?(?:system_call|function_calls?|tool_calls?|custom_tool_call)\b|<name\s*=|<\/?(?:｜｜(?:DSML|DS)｜｜|｟DSML｠))/i.test(source) ||
    /(?:^|\n)[\t ]*<system_call\b[^>]*>\s*<name\s*=/i.test(source);
}

/** The observed unsupported envelope has no legitimate final-text decoding path. */
export function isLeakedFinalProtocol(text: string): boolean {
  const source=text.trim().replace(/^```(?:xml|json|text)?\s*\n([\s\S]*?)\n```$/i,'$1').trimStart();
  return /^<system_call\b[^>]*>\s*<name\s*=/i.test(source);
}

/** A streamed final may start with a split protocol tag; wait until it can be ruled out. */
export function mayStartToolProtocol(text: string): boolean {
  const start = text.trimStart().toLowerCase();
  if (!start) return true;
  return ['<system_call', '</system_call', '<function_call', '<tool_call', '<custom_tool_call', '<name',
    '<｜｜', '</｜｜', '<｟', '</｟', '```'].some(tag => tag.startsWith(start) || start.startsWith(tag));
}
