/** Tool names are identifiers; corrupted names can contain entire commands or code. */
export function diagnosticToolName(name: string): string {
  return /^[A-Za-z_][\w.-]{0,127}$/.test(name) ? name : '[malformed tool name]';
}
export function diagnosticSummary(error: string | null | undefined): string | null {
  if (!error) return null;
  const prefix = 'Unknown or unselected tool name: ';
  if (error.startsWith(prefix)) return prefix + diagnosticToolName(error.slice(prefix.length));
  return error.slice(0, 240);
}

/** Read SDK failure metadata only; never expose arbitrary provider text or classify host-tool output. */
export function publicUpstreamFailure(sdkErrors: unknown[] = [], apiCategories: string[] = []) {
  const text=sdkErrors.filter((value):value is string=>typeof value==='string').join('\n');
  if(/\b(?:reached|exceeded)\b[\s\S]{0,100}\bdaily\s+(?:usage\s+)?limit\b|\bdaily\s+(?:usage\s+)?limit\b[\s\S]{0,100}\b(?:reached|exceeded|exhausted)\b/i.test(text))
    return {code:'upstream_daily_limit',message:'Qoder daily usage limit reached. No automatic retry was attempted; wait for the provider quota to become available.'};
  if(apiCategories.includes('billing_error'))
    return {code:'upstream_billing_error',message:'Qoder reported a billing or quota error. No automatic retry was attempted; check the provider account quota.'};
  if(apiCategories.includes('authentication_failed'))
    return {code:'upstream_authentication_failed',message:'Qoder authentication failed. No automatic retry was attempted; restore provider authentication before continuing.'};
  if(apiCategories.includes('rate_limit'))
    return {code:'upstream_rate_limit',message:'Qoder reported a rate limit. No automatic retry was attempted; wait until the provider permits another request.'};
  return null;
}
