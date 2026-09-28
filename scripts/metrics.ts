import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const limit = Number(value('--limit') ?? '20');
if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Limit must be 1..10000');
const session = value('--session');
const hash = session ? createHash('sha256').update(session).digest('hex').slice(0, 12) : undefined;
const data = (await readFile('reports/tasks.ndjson', 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const rows = [...new Map(data.filter(row => row.bridge_port !== 0 && (!hash || row.harness_session_key_hash === hash))
  .map(row => [row.bridge_request_id, row])).values()].slice(-limit);
const attempts = rows.filter(row => !row.telemetry?.local_response_replay);
const known = rows.filter(row => typeof row.telemetry?.credits_delta === 'number');
const sumCredits = (items: any[]) => Number(items.reduce((n, row) => n + row.telemetry.credits_delta, 0).toFixed(6));
const p50 = (items: unknown[]) => {
  const values = items.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
};
const reported = attempts.filter(row => row.telemetry?.usage != null);
const tokens = (field: 'prompt_tokens' | 'completion_tokens') => reported.reduce((n, row) => n + row.telemetry.usage[field], 0);
const cacheKnown = reported.filter(row => row.telemetry?.cache_status === 'reported');
const hit = cacheKnown.reduce((n, row) => n + (row.telemetry.usage.prompt_tokens_details?.cached_tokens ?? 0), 0);
const prompt = cacheKnown.reduce((n, row) => n + row.telemetry.usage.prompt_tokens, 0);
const estimated = reported.filter(row => typeof row.telemetry?.cache_estimate_tokens === 'number');
const estimatedPrompt = estimated.reduce((n, row) => n + row.telemetry.usage.prompt_tokens, 0);
console.log(JSON.stringify({ scope: hash ?? `latest ${limit} Bridge requests`,
  since: rows[0]?.time ?? null, until: rows.at(-1)?.time ?? null,
  requests: rows.length, modelAttempts: attempts.length, localReplays: rows.length - attempts.length,
  errors: rows.filter(row => row.status === 'error').length,
  knownCredits: sumCredits(known), failedKnownCredits: sumCredits(known.filter(row => row.status === 'error')),
  unknownCreditRequests: rows.length - known.length,
  medianFirstTextMs: p50(attempts.map(row => row.telemetry?.first_client_text_ms)),
  medianFirstThinkingMs: p50(attempts.map(row => row.telemetry?.first_client_thinking_ms)),
  medianRequestMs: p50(attempts.map(row => row.elapsed_ms)),
  tokenUsage: { reportedRequests: reported.length, unavailableRequests: attempts.length - reported.length,
    promptTokens: tokens('prompt_tokens'), completionTokens: tokens('completion_tokens'),
    reasoningTokens: reported.reduce((n, row) => n + (row.telemetry.usage.completion_tokens_details?.reasoning_tokens ?? 0), 0),
    medianOutputTokensPerSecond: p50(reported.map(row => row.telemetry?.output_tokens_per_second)) },
  cacheHitRatio: cacheKnown.length === attempts.length && prompt > 0 ? hit / prompt : null,
  sessionPrefixCacheEstimate: estimatedPrompt > 0
    ? estimated.reduce((n, row) => n + row.telemetry.cache_estimate_tokens, 0) / estimatedPrompt : null,
  note: 'Tokens: Qoder context_usage_ratio x policy window (prompt) and streamed token deltas (output, reasoning ' +
    'included). Qoder reports no cache counts, so the prefix figure is an estimate; local replay is not a provider ' +
    'cache hit. Credits are recorded consumption. Unavailable data stays null.',
}, null, 2));
