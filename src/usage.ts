export type OpenAIUsage = {
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens: number };
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** SDK counts use Anthropic layout: input_tokens excludes separately reported cache reads/writes. */
export function reportedUsage(value: unknown): OpenAIUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  if (!count(usage.input_tokens) || !count(usage.output_tokens)) return null;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  if ((read !== undefined && !count(read)) || (write !== undefined && !count(write))) return null;
  const prompt = usage.input_tokens + (count(read) ? read : 0) + (count(write) ? write : 0);
  if (prompt + usage.output_tokens === 0) return null;
  return { prompt_tokens: prompt, completion_tokens: usage.output_tokens,
    total_tokens: prompt + usage.output_tokens,
    ...(count(read) && count(write) ? { prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } } : {}) };
}

export function aggregateUsage(values: unknown[]): OpenAIUsage | null {
  const rows = values.map(reportedUsage);
  if (!rows.length || rows.some(row => row === null)) return null;
  const known = rows as OpenAIUsage[];
  const prompt = known.reduce((n, row) => n + row.prompt_tokens, 0);
  const completion = known.reduce((n, row) => n + row.completion_tokens, 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(known.every(row => row.prompt_tokens_details) ? { prompt_tokens_details: {
      cached_tokens: known.reduce((n, row) => n + row.prompt_tokens_details!.cached_tokens, 0),
      cache_write_tokens: known.reduce((n, row) => n + (row.prompt_tokens_details!.cache_write_tokens ?? 0), 0),
    } } : {}) };
}

/** Per-response stream counters. Qoder zero-fills token fields but streams exactly one delta per token. */
export type StreamTokens = {
  contextRatio: number | null; textTokens: number; reasoningTokens: number;
  chars: number; maxDeltaChars: number; foreignDeltas: number;
};
/** A batched stream would inflate chars per delta; refuse to call such counts tokens. */
export function tokenDeltasReliable(stream: StreamTokens) {
  const deltas = stream.textTokens + stream.reasoningTokens;
  return stream.foreignDeltas === 0 && stream.maxDeltaChars <= 256 && (deltas < 32 || stream.chars / deltas <= 12);
}

/**
 * Usage measured from what Qoder does report: `context_usage_ratio` is the request's prompt size over the
 * context window chosen by our model policy (integer tokens / window), and each streamed text/thinking
 * delta is one output token. Validated against the next turn's context growth; see docs/update-and-streaming.md.
 */
export function measuredUsage(streams: StreamTokens[], contextWindow: number | null): OpenAIUsage | null {
  if (!streams.length || !count(contextWindow) || contextWindow === 0) return null;
  let prompt = 0; let completion = 0; let reasoning = 0;
  for (const stream of streams) {
    const ratio = stream.contextRatio;
    if (typeof ratio !== 'number' || !(ratio > 0 && ratio <= 1) || !tokenDeltasReliable(stream)) return null;
    prompt += Math.round(ratio * contextWindow);
    completion += stream.textTokens + stream.reasoningTokens;
    reasoning += stream.reasoningTokens;
  }
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: reasoning } };
}

/** DeepSeek builds its prefix cache in 64-token units. */
const CACHE_UNIT = 64;
/**
 * Session-prefix cache estimate: a continued Qoder session re-sends the previous request's prompt as an exact
 * prefix, so at most that many tokens can be cache reads. Qoder never reports actual hits; this is an upper-bound
 * style estimate that misses cross-session hits and evictions, and is only sent to clients when opted in.
 */
export function prefixCacheEstimate(promptTokens: number, previousPromptTokens: number | null) {
  if (!count(previousPromptTokens)) return 0;
  return Math.floor(Math.min(previousPromptTokens, promptTokens) / CACHE_UNIT) * CACHE_UNIT;
}
export function withCachedTokens(usage: OpenAIUsage, cached: number): OpenAIUsage {
  return { ...usage, prompt_tokens_details: { cached_tokens: Math.min(cached, usage.prompt_tokens) } };
}
export const ZERO_USAGE: Readonly<OpenAIUsage> = Object.freeze({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
