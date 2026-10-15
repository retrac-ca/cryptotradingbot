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

/**
 * Default maximum age (ms) of the newest completed candle before a candle
 * series is considered stale. Three intervals tolerates one missed/gap bar plus
 * a small margin while still failing closed on a genuinely stale series (P2).
 */
export function defaultCandleMaxAgeMs(timeframe: Timeframe): number {
  return 3 * TIMEFRAME_MS[timeframe];
}

export type CandleFreshnessCheck =
  | { fresh: true; newestTimestampMs: number }
  | { fresh: false; reason: 'CANDLE_MISSING' | 'CANDLE_STALE'; detail: string };

/**
 * P2: age-check the candle series used for a decision. A strategy must not
 * evaluate a stale candle series while the ticker is fresh enough for risk
 * approval. `timestampMs` is the candle END/CLOSE time, so the newest completed
 * candle's timestamp is its close time; if that close is older than `maxAgeMs`
 * the series is stale. Missing (no completed candle) also fails closed.
 *
 * Pure and deterministic; the same policy is used by the continuous engine.
 */
export function evaluateCandleFreshness(
  candles: Candle[],
  nowMs: number,
  maxAgeMs: number,
): CandleFreshnessCheck {
  const newest = candles.reduce<number | null>(
    (acc, c) => (acc === null || c.timestampMs > acc ? c.timestampMs : acc),
    null,
  );
  if (newest === null) {
    return { fresh: false, reason: 'CANDLE_MISSING', detail: 'no completed candle available' };
  }
  if (nowMs - newest > maxAgeMs) {
    return {
      fresh: false,
      reason: 'CANDLE_STALE',
      detail: `newest completed candle is ${nowMs - newest}ms old (max ${maxAgeMs}ms)`,
    };
  }
  return { fresh: true, newestTimestampMs: newest };
}
