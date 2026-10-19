import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheFromCredits, CREDITS_PER_CNY, MODEL_TARIFFS, TierCalendar } from '../src/billing.js';

/** Credits Qoder would bill for a request under the published tariff. */
function bill(model: string, prompt: number, hits: number, output: number, peak = false) {
  const t = MODEL_TARIFFS[model]!;
  return CREDITS_PER_CNY * (peak ? 2 : 1) * (t.miss * (prompt - hits) + t.hit * hits + t.output * output) / 1e6;
}
const saturday = new Date('2026-10-17T03:00:00Z');   // 11:00 Beijing, weekend
const mondayPeak = new Date('2026-10-19T02:00:00Z'); // 10:00 Beijing, weekday peak
const mondayLunch = new Date('2026-10-19T04:30:00Z'); // 12:30 Beijing, between peak windows

test('the published calendar marks weekday working hours as peak and everything else off-peak', () => {
  const calendar = new TierCalendar();
  assert.equal(calendar.tier(mondayPeak), 'peak');
  assert.equal(calendar.tier(mondayLunch), 'off_peak');
  assert.equal(calendar.tier(saturday), 'off_peak');
  assert.equal(calendar.tier(new Date('2026-10-19T01:00:00Z')), 'peak');     // 09:00
  assert.equal(calendar.tier(new Date('2026-10-19T09:59:00Z')), 'peak');     // 17:59
  assert.equal(calendar.tier(new Date('2026-10-19T10:00:00Z')), 'off_peak'); // 18:00
  assert.equal(new TierCalendar(['2026-10-19']).tier(mondayPeak), 'off_peak');
});
test('billed Credits invert exactly into cache-read tokens for both tiers and both models', () => {
  const calendar = new TierCalendar();
  const offPeak = cacheFromCredits({ model: 'dfmodel', promptTokens: 200_000, outputTokens: 1_500,
    credits: bill('dfmodel', 200_000, 196_000, 1_500), at: saturday, calendar });
  assert.equal(offPeak?.cachedTokens, 196_000); assert.equal(offPeak?.uncachedTokens, 4_000); assert.equal(offPeak?.tier, 'off_peak');
  const peak = cacheFromCredits({ model: 'dfmodel', promptTokens: 200_000, outputTokens: 1_500,
    credits: bill('dfmodel', 200_000, 196_000, 1_500, true), at: mondayPeak, calendar, prefixHint: 195_900 });
  assert.equal(peak?.cachedTokens, 196_000); assert.equal(peak?.tier, 'peak');
  const pro = cacheFromCredits({ model: 'dmodel', promptTokens: 50_000, outputTokens: 500,
    credits: bill('dmodel', 50_000, 40_000, 500), at: saturday, calendar });
  assert.equal(pro?.cachedTokens, 40_000);
});
test('an off-peak bill on a calendar peak day is learned as a holiday for the rest of that date', () => {
  const calendar = new TierCalendar();
  const holiday = cacheFromCredits({ model: 'dfmodel', promptTokens: 300_000, outputTokens: 800,
    credits: bill('dfmodel', 300_000, 298_000, 800), at: mondayPeak, calendar, prefixHint: 298_000 });
  assert.equal(holiday?.tier, 'off_peak'); assert.equal(holiday?.cachedTokens, 298_000); assert.equal(holiday?.learnedCalendar, true);
  assert.equal(calendar.tier(new Date('2026-10-19T07:00:00Z')), 'off_peak');
  assert.deepEqual(calendar.learnedDates(), { '2026-10-19': 'off_peak' });
});
test('bills the tariff cannot explain, unknown models and free requests yield no cache figure', () => {
  const calendar = new TierCalendar();
  const base = { model: 'dfmodel', promptTokens: 10_000, outputTokens: 100, at: saturday, calendar };
  assert.equal(cacheFromCredits({ ...base, credits: bill('dfmodel', 10_000, 0, 100) * 5 }), null);
  assert.equal(cacheFromCredits({ ...base, model: 'unknown', credits: 0.1 }), null);
  assert.equal(cacheFromCredits({ ...base, credits: 0 }), null);
  assert.equal(cacheFromCredits({ ...base, promptTokens: 0, credits: 0.1 }), null);
  // A tiny overshoot from rounding is clamped instead of rejected.
  const full = cacheFromCredits({ ...base, credits: bill('dfmodel', 10_000, 10_000, 100) * 0.999 });
  assert.equal(full?.cachedTokens, 10_000);
});
