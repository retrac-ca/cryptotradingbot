/**
 * Mean-reversion strategy (V1.3 Strategy Lab — experiment 2).
 *
 * A long-only, close-based mean-reversion rule:
 *   - FLAT: BUY when the latest completed close is sufficiently EXTENDED BELOW
 *     its `period`-bar simple moving average, i.e.
 *       deviation = (MA - close) / MA >= deviationThreshold
 *     (pre-registered: period = 48, deviationThreshold = 0.015).
 *   - LONG: SELL when the latest completed close has reverted BACK TO OR ABOVE
 *     the moving average, i.e. `close >= MA`.
 *   - Otherwise HOLD.
 *
 * Properties (deliberate, to keep the experiment clean):
 *   - Completed candles only; the current close IS included in its own moving
 *     average (MA is the average of the latest `period` closes).
 *   - Stateless: the signal is a pure function of the supplied candle history,
 *     the current position, and the fixed parameters. A fresh instance given
 *     the same context yields the same signal (restart/replay safe).
 *   - Long-only: never BUY while long, never SELL while flat, no shorting, no
 *     pyramiding.
 *   - Boundary semantics: deviation == threshold qualifies for BUY;
 *     close == MA qualifies for SELL.
 *   - No strategy-specific stop-loss, trend filter, volatility filter, RSI, or
 *     Bollinger Bands. The existing risk/execution path is unchanged and its
 *     configured stop remains the only stop.
 *
 * All price/moving-average arithmetic uses the exact fixed-point `Money` type —
 * no floating point is used for prices.
 */

import { Money } from '../money/Money.js';
import { sma } from './indicators.js';
import type { StrategyContext } from './StrategyContext.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './Signal.js';
import { signal } from './Signal.js';
import { registerStrategy, type StrategyRegistryParams } from './registry.js';

/** Pre-registered moving-average period (48 completed 5m candles ≈ 4h). */
export const DEFAULT_MEAN_REVERSION_PERIOD = 48;
/** Pre-registered extension threshold below the MA (0.015 = 1.5%). */
export const DEFAULT_MEAN_REVERSION_DEVIATION = 0.015;

export interface MeanReversionParams {
  /** Number of completed closes in the simple moving average (>= 1). */
  period: number;
  /** Minimum fractional extension below the MA required to enter, in (0, 1). */
  deviationThreshold: number;
}

export class MeanReversionStrategy implements Strategy {
  readonly id = 'mean-reversion';
  readonly name = 'Mean Reversion';
  readonly timeframe;
  readonly warmupCandles;
  readonly period;
  readonly deviationThreshold;
  /** Exact fixed-point entry threshold (`deviationThreshold` resolved to 1e-9). */
  private readonly deviationThresholdMoney: Money;

  constructor(timeframe: Strategy['timeframe'], params: MeanReversionParams) {
    const { period, deviationThreshold } = params;
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error('MeanReversion: period must be a positive integer.');
    }
    if (!Number.isFinite(deviationThreshold) || deviationThreshold <= 0 || deviationThreshold >= 1) {
      throw new Error('MeanReversion: deviationThreshold must be a finite fraction in (0, 1).');
    }
    this.timeframe = timeframe;
    this.period = period;
    this.deviationThreshold = deviationThreshold;
    // One current candle plus `period` prior candles (pre-registered warmup).
    this.warmupCandles = period + 1;
    // Resolve the fraction to an exact fixed-point value over 1e9 (no floats at
    // comparison time). e.g. 0.015 -> 0.015000000.
    const scale = 1_000_000_000n;
    const numerator = BigInt(Math.round(deviationThreshold * Number(scale)));
    this.deviationThresholdMoney = numerator === 0n
      ? Money.zero()
      : Money.fromScaled((numerator * 100_000_000n) / scale);
  }

  evaluate(context: StrategyContext): Signal {
    const { symbol, candles, position, nowMs, insufficientData } = context;

    if (insufficientData || candles.length < this.warmupCandles) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    const latestClose = candles[candles.length - 1]!.close;
    const ma = sma(candles, this.period);
    if (ma === null || !ma.isPositive()) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    // --- Long: exit once price has reverted to/above the moving average. ---
    if (position.quantity.isPositive()) {
      if (latestClose.compareTo(ma) >= 0) {
        return signal(
          symbol,
          'SELL',
          { confidence: 0.6, reason: `close ${latestClose} reverted to/above MA${this.period} ${ma}` },
          nowMs,
        );
      }
      return signal(symbol, 'HOLD', { reason: 'holding long' }, nowMs);
    }

    // A negative/non-zero non-long quantity is never traded (V1 is long-only).
    if (!position.quantity.isZero()) {
      return signal(symbol, 'HOLD', { reason: 'non-flat position' }, nowMs);
    }

    // --- Flat: enter when sufficiently extended below the moving average. ---
    // deviation = (MA - close) / MA, compared as exact fixed-point Money.
    const deviation = ma.sub(latestClose).div(ma);
    if (deviation.compareTo(this.deviationThresholdMoney) >= 0) {
      return signal(
        symbol,
        'BUY',
        {
          confidence: 0.6,
          reason: `close ${latestClose} is ${deviation} below MA${this.period} ${ma}`,
        },
        nowMs,
      );
    }
    return signal(symbol, 'HOLD', { reason: 'not extended enough' }, nowMs);
  }

  describe(): string {
    return `mean-reversion(period=${this.period}, deviation=${this.deviationThreshold})`;
  }
}

// Self-registration mirrors the MA/Donchian strategies: importing this module
// makes the strategy available to createStrategy(). The pre-registered
// experiment values (period=48, deviation=0.015) are the defaults; they are not
// exposed through the normal `.env` configuration.
registerStrategy('mean-reversion', (params: StrategyRegistryParams) => {
  const period = typeof params.period === 'number' ? params.period : DEFAULT_MEAN_REVERSION_PERIOD;
  const deviationThreshold =
    typeof params.deviationThreshold === 'number'
      ? params.deviationThreshold
      : DEFAULT_MEAN_REVERSION_DEVIATION;
  return new MeanReversionStrategy(params.timeframe, { period, deviationThreshold });
});
