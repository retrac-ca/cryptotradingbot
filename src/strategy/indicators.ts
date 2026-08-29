/**
 * Pure technical indicators that operate on canonical `Candle[]` series.
 *
 * These are kept free of I/O and strategy logic so they are trivially unit
 * testable and reusable across strategies. All arithmetic uses `Money`
 * (fixed-point BigInt) — no floating point.
 */

import { Money } from '../money/Money.js';
import type { Candle } from '../types.js';

/** Simple moving average of close prices over the last `period` candles. */
export function sma(candles: Candle[], period: number): Money | null {
  if (period <= 0) return null;
  if (candles.length < period) return null;
  const window = candles.slice(candles.length - period);
  let total = Money.zero();
  for (const c of window) total = total.add(c.close);
  return total.mulFraction(1n, BigInt(period));
}

/**
 * Exponential moving average of close prices.
 * Uses `alpha = 2 / (period + 1)`. When seedPeriod is given, the EMA is seeded
 * by an SMA over that many candles to avoid a slow warm-up bias; otherwise
 * alpha is applied from the first candle.
 */
export function ema(candles: Candle[], period: number, seedPeriod?: number): Money | null {
  if (period <= 0) return null;
  if (candles.length === 0) return null;

  const seedN = seedPeriod ?? period;
  const values = candles.map((c) => c.close);
  let emaSoFar: Money;

  if (values.length <= seedN) {
    // Not enough data to seed the EMA: fall back to SMA of what we have.
    return sma(candles, values.length);
  }

  // Seed with SMA over the first `seedN` candles.
  let total = Money.zero();
  for (let i = 0; i < seedN; i++) total = total.add(values[i]!);
  emaSoFar = total.mulFraction(1n, BigInt(seedN));

  const alphaNumerator = 2n;
  const alphaDenominator = BigInt(period + 1); // alpha = 2 / (period+1)

  for (let i = seedN; i < values.length; i++) {
    // ema = close * alpha + ema * (1 - alpha)
    const closePart = values[i]!.mulFraction(alphaNumerator, alphaDenominator);
    const prevPart = emaSoFar.mulFraction(alphaDenominator - alphaNumerator, alphaDenominator);
    emaSoFar = closePart.add(prevPart);
  }
  return emaSoFar;
}
