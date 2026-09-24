/**
 * Candle-series helpers shared by the live/paper decision path.
 *
 * Two concerns live here:
 *  1. COMPLETED CANDLES ONLY (F7): `Candle.timestampMs` is the candle
 *     END/CLOSE time, so the currently-forming candle has an end time in the
 *     future. Strategy decisions must only ever see completed candles, so the
 *     live/paper decision input matches the backtest input for equivalent
 *     completed data.
 *  2. WARMUP LOOKBACK (F4): the candle history requested from an exchange must
 *     be large enough to warm up the configured strategy on the configured
 *     timeframe, with margin. The lookback is derived generically from the
 *     timeframe length and the strategy's warmup requirement (no per-timeframe
 *     special cases).
 */

import type { Candle, Timeframe } from '../types.js';

/** Interval (ms) for each supported timeframe. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/**
 * Extra bars requested beyond the strategy warmup, so sparse/gap-y markets and
 * the excluded forming candle still leave enough completed bars to warm up.
 */
export const CANDLE_WARMUP_MARGIN_BARS = 10;

/**
 * The candle history lookback (ms) required to warm up a strategy needing
 * `warmupCandles` completed candles on `timeframe`, plus a safety margin.
 */
export function requiredCandleLookbackMs(timeframe: Timeframe, warmupCandles: number): number {
  const barMs = TIMEFRAME_MS[timeframe];
  const bars = Math.max(1, Math.ceil(warmupCandles)) + CANDLE_WARMUP_MARGIN_BARS;
  return barMs * bars;
}

/**
 * Return only the candles that are COMPLETE at `nowMs`.
 *
 * Because `timestampMs` is the candle END time, a candle is complete when its
 * end time is at or before `nowMs`. This excludes the currently-forming candle
 * while KEEPING the most recently completed candle. An empty result is safe:
 * the strategy sees insufficient data and returns HOLD.
 */
export function completedCandles(candles: Candle[], nowMs: number): Candle[] {
  if (candles.length === 0) return candles;
  return candles.filter((c) => c.timestampMs <= nowMs);
}
