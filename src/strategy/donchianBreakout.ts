/**
 * Donchian breakout strategy (V1.3 Strategy Lab — experiment 1).
 *
 * A long-only, close-based momentum/breakout rule:
 *   - Flat: BUY when the latest completed close is STRICTLY ABOVE the highest
 *     close of the PRIOR `lookbackPeriod` completed candles.
 *   - Long: SELL when the latest completed close is STRICTLY BELOW the lowest
 *     close of the PRIOR `lookbackPeriod` completed candles.
 *   - Otherwise HOLD.
 *
 * Properties (deliberate, to keep the experiment clean):
 *   - STRICTLY causal: the latest candle is compared against a window of the
 *     PRIOR candles only, so the latest close is never part of its own window.
 *   - Stateless: the signal is a pure function of the supplied candle history,
 *     the current position, and the fixed lookback. A fresh instance given the
 *     same context yields the same signal (restart/replay safe).
 *   - Long-only: never BUY while long, never SELL while flat, no shorting, no
 *     pyramiding.
 *   - Equality is NOT a breakout (`close == priorHigh` / `close == priorLow`
 *     both HOLD).
 *   - No strategy-specific stop-loss: the existing risk/execution path is
 *     unchanged and still applies.
 *
 * All price comparisons use the exact fixed-point `Money` type — no floating
 * point is used for prices.
 */

import type { Money } from '../money/Money.js';
import type { StrategyContext } from './StrategyContext.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './Signal.js';
import { signal } from './Signal.js';
import { registerStrategy, type StrategyRegistryParams } from './registry.js';

/** Pre-registered lookback for the V1.3 experiment (48 completed 5m candles ≈ 4h). */
export const DEFAULT_DONCHIAN_LOOKBACK = 48;

export interface DonchianBreakoutParams {
  /** Number of PRIOR completed candles in the breakout window (>= 1). */
  lookbackPeriod: number;
}

export class DonchianBreakoutStrategy implements Strategy {
  readonly id = 'donchian-breakout';
  readonly name = 'Donchian Breakout';
  readonly timeframe;
  readonly warmupCandles;
  readonly lookbackPeriod;

  constructor(timeframe: Strategy['timeframe'], params: DonchianBreakoutParams) {
    const n = params.lookbackPeriod;
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('DonchianBreakout: lookbackPeriod must be a positive integer.');
    }
    this.timeframe = timeframe;
    this.lookbackPeriod = n;
    // One current candle plus N prior candles to form the comparison window.
    this.warmupCandles = n + 1;
  }

  evaluate(context: StrategyContext): Signal {
    const { symbol, candles, position, nowMs, insufficientData } = context;

    if (insufficientData || candles.length < this.warmupCandles) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    const latestClose = candles[candles.length - 1]!.close;

    // Window of the PRIOR N completed candles: indices [len-1-N, len-2].
    // The latest candle (len-1) is deliberately EXCLUDED.
    const windowStart = candles.length - 1 - this.lookbackPeriod;
    let priorHigh: Money | null = null;
    let priorLow: Money | null = null;
    for (let i = windowStart; i < candles.length - 1; i++) {
      const close = candles[i]!.close;
      if (priorHigh === null || close.compareTo(priorHigh) > 0) priorHigh = close;
      if (priorLow === null || close.compareTo(priorLow) < 0) priorLow = close;
    }
    // Defensive: cannot happen given the warmup guard, but never guess.
    if (priorHigh === null || priorLow === null) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    // --- Long: exit on a confirmed breakdown (strictly below prior low). ---
    if (position.quantity.isPositive()) {
      if (latestClose.compareTo(priorLow) < 0) {
        return signal(
          symbol,
          'SELL',
          {
            confidence: 0.6,
            reason: `close ${latestClose} below prior ${this.lookbackPeriod}-bar low ${priorLow}`,
          },
          nowMs,
        );
      }
      return signal(symbol, 'HOLD', { reason: 'holding long' }, nowMs);
    }

    // A negative/non-zero non-long quantity is never traded (V1 is long-only).
    if (!position.quantity.isZero()) {
      return signal(symbol, 'HOLD', { reason: 'non-flat position' }, nowMs);
    }

    // --- Flat: enter on a confirmed breakout (strictly above prior high). ---
    if (latestClose.compareTo(priorHigh) > 0) {
      return signal(
        symbol,
        'BUY',
        {
          confidence: 0.6,
          reason: `close ${latestClose} above prior ${this.lookbackPeriod}-bar high ${priorHigh}`,
        },
        nowMs,
      );
    }
    return signal(symbol, 'HOLD', { reason: 'no breakout' }, nowMs);
  }

  describe(): string {
    return `donchian-breakout(N=${this.lookbackPeriod})`;
  }
}

// Self-registration mirrors the MA strategy: importing this module makes the
// strategy available to createStrategy(). The pre-registered experiment value
// (N=48) is the default; it is not exposed through the normal `.env` config.
registerStrategy('donchian-breakout', (params: StrategyRegistryParams) => {
  const n =
    typeof params.lookbackPeriod === 'number' ? params.lookbackPeriod : DEFAULT_DONCHIAN_LOOKBACK;
  return new DonchianBreakoutStrategy(params.timeframe, { lookbackPeriod: n });
});
