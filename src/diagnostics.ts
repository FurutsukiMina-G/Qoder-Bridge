import { upstreamDiagnosis } from './failures.js';

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
export function publicUpstreamFailure(sdkErrors: unknown[] = [], apiCategories: string[] = [], sdkCode?: unknown) {
  const d = upstreamDiagnosis(sdkErrors, apiCategories, sdkCode);
  return d ? { code: d.code, message: d.reason, origin: d.origin, evidence: d.evidence } : null;
}
