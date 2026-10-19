/**
 * Billing-derived cache accounting. Qoder zero-fills token and cache fields but reports each request's Credits.
 * Fitted on real long-task logs (2026-10): Credits = CREDITS_PER_CNY x DeepSeek's published CNY list price, with
 * the published 2x Beijing peak calendar (median error 0.47% on continuation requests). Given exact prompt and
 * output tokens, the only unknown in that price is the cache-read share, so it can be solved per request.
 * This is an inference from billing, not a field Qoder reports; callers must keep its source label.
 */
export type Tariff = { miss: number; hit: number; output: number };
/** DeepSeek list prices, CNY per 1M tokens, off-peak (api-docs.deepseek.com, quick_start/pricing, 2026-10). */
export const MODEL_TARIFFS: Readonly<Record<string, Tariff>> = Object.freeze({
  dfmodel: { miss: 1, hit: 0.02, output: 4 },
  dmodel: { miss: 4.5, hit: 0.15, output: 13.5 },
});
export const CREDITS_PER_CNY = 22.22;
export const PEAK_MULTIPLIER = 2;
export type Tier = 'peak' | 'off_peak';

const BEIJING_OFFSET_MS = 8 * 3600_000;
export const beijingDate = (at: Date) => new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Published calendar: Beijing Monday-Friday 09:00-12:00 and 14:00-18:00 are peak; weekends and statutory
 * holidays are off-peak. Holiday and make-up-workday dates are learned from billing (see TierCalendar).
 */
export class TierCalendar {
  private overrides = new Map<string, Tier>();
  constructor(offPeakDates: Iterable<string> = []) { for (const date of offPeakDates) this.overrides.set(date, 'off_peak'); }
  private static peakHours(at: Date) {
    const local = new Date(at.getTime() + BEIJING_OFFSET_MS);
    const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
    return { weekday: local.getUTCDay(), inPeakHours: (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) };
  }
  tier(at: Date): Tier {
    const { weekday, inPeakHours } = TierCalendar.peakHours(at);
    if (!inPeakHours) return 'off_peak';
    return this.overrides.get(beijingDate(at)) ?? (weekday === 0 || weekday === 6 ? 'off_peak' : 'peak');
  }
  /** Only peak-hour evidence can reveal a holiday (billed off-peak) or a make-up workday (billed peak). */
  learn(at: Date, billed: Tier) {
    if (!TierCalendar.peakHours(at).inPeakHours || billed === this.tier(at)) return false;
    this.overrides.set(beijingDate(at), billed);
    return true;
  }
  learnedDates() { return Object.fromEntries(this.overrides); }
}
// 2026 National Day holiday, confirmed as off-peak by billing during peak hours.
export const sharedTierCalendar = new TierCalendar(['2026-10-01', '2026-10-02']);

export type BillingCache = {
  source: 'qoder_credits_inverse'; cachedTokens: number; uncachedTokens: number;
  tier: Tier; calendarTier: Tier; residualTokens: number; learnedCalendar: boolean;
};
/**
 * Solve Credits = K * m * (miss*(P-H) + hit*H + output*O) / 1e6 for the cache-read tokens H.
 * Returns null when no tier yields H inside [0, P] within tolerance: the tariff no longer explains the bill.
 */
export function cacheFromCredits(input: {
  model: string; promptTokens: number; outputTokens: number; credits: number; at: Date;
  /** Previous prompt of the same Qoder session: the expected cached prefix when the calendar is ambiguous. */
  prefixHint?: number | null; calendar?: TierCalendar; creditsPerCny?: number;
}): BillingCache | null {
  const tariff = MODEL_TARIFFS[input.model];
  const P = input.promptTokens, O = input.outputTokens;
  if (!tariff || !(input.credits > 0) || !Number.isSafeInteger(P) || P <= 0 || !Number.isSafeInteger(O) || O < 0) return null;
  const calendar = input.calendar ?? sharedTierCalendar;
  const K = input.creditsPerCny ?? CREDITS_PER_CNY;
  const hits = (tier: Tier) => {
    const listPrice = input.credits * 1e6 / (K * (tier === 'peak' ? PEAK_MULTIPLIER : 1));
    return (tariff.miss * P + tariff.output * O - listPrice) / (tariff.miss - tariff.hit);
  };
  const tolerance = Math.max(128, P * 0.01);
  const expected = calendar.tier(input.at);
  const candidates = (['peak', 'off_peak'] as const).map(tier => ({ tier, hits: hits(tier) }))
    .filter(row => row.hits >= -tolerance && row.hits <= P + tolerance);
  if (!candidates.length) return null;
  let chosen = candidates.find(row => row.tier === expected) ?? candidates[0]!;
  const other = candidates.find(row => row !== chosen);
  const hint = typeof input.prefixHint === 'number' && input.prefixHint > 0 ? Math.min(input.prefixHint, P) : null;
  // Both tiers can fit a small bill. Prefer the calendar unless the prefix strongly favours the other tier.
  if (other && hint !== null && Math.abs(chosen.hits - hint) > Math.max(512, 0.02 * P) &&
    Math.abs(other.hits - hint) <= Math.max(256, 0.005 * P)) chosen = other;
  const learnedCalendar = (chosen.tier !== expected && (candidates.length === 1 || chosen === other))
    ? calendar.learn(input.at, chosen.tier) : false;
  const cachedTokens = Math.round(Math.min(P, Math.max(0, chosen.hits)));
  return { source: 'qoder_credits_inverse', cachedTokens, uncachedTokens: P - cachedTokens, tier: chosen.tier,
    calendarTier: expected, residualTokens: Math.round(chosen.hits) - cachedTokens, learnedCalendar };
}
