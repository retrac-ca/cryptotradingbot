/**
 * Moving Average Crossover strategy.
 *
 * A straightforward, fully deterministic trend-following rule:
 *   - Fast SMA vs Slow SMA of close prices on the strategy timeframe.
 *   - BUY when the fast MA crosses ABOVE the slow MA (golden cross) while flat.
 *   - SELL when the fast MA crosses BELOW the slow MA (death cross) while long.
 *   - HOLD otherwise.
 *
 * Signals are emitted only on cross transitions (not on every tick), which
 * avoids stacking duplicate orders while the fast MA stays on one side.
 *
 * This is intentionally simple — its purpose is to prove the
 * strategy -> signal pipeline, not to be profitable yet.
 */

import type { StrategyContext } from './StrategyContext.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './Signal.js';
import { signal } from './Signal.js';
import { sma } from './indicators.js';
import { registerStrategy, type StrategyRegistryParams } from './registry.js';

export interface MovingAverageCrossoverParams {
  /** Fast SMA period (must be < slowPeriod). */
  fastPeriod: number;
  /** Slow SMA period. */
  slowPeriod: number;
}

export class MovingAverageCrossoverStrategy implements Strategy {
  readonly id = 'moving-average-crossover';
  readonly name = 'Moving Average Crossover';
  readonly timeframe;
  readonly warmupCandles;
  readonly fastPeriod;
  readonly slowPeriod;

  /** Per-symbol last known fast-vs-slow relationship (null until first computed). */
  private crossState = new Map<string, boolean | null>();

  constructor(timeframe: Strategy['timeframe'], params: MovingAverageCrossoverParams) {
    if (params.fastPeriod <= 0 || params.slowPeriod <= 0) {
      throw new Error('MA crossover periods must be positive integers.');
    }
    if (params.slowPeriod <= params.fastPeriod) {
      throw new Error('MovingAverageCrossover: slowPeriod must be greater than fastPeriod.');
    }
    this.timeframe = timeframe;
    this.fastPeriod = params.fastPeriod;
    this.slowPeriod = params.slowPeriod;
    // Need at least the slow period of candles plus one so both MAs are warm.
    this.warmupCandles = params.slowPeriod + 1;
  }

  evaluate(context: StrategyContext): Signal {
    const { symbol, candles, position, nowMs, insufficientData } = context;

    if (insufficientData || candles.length < this.warmupCandles) {
      // Not enough data to trust a cross yet.
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    const fast = sma(candles, this.fastPeriod);
    const slow = sma(candles, this.slowPeriod);
    if (fast === null || slow === null) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    const nowFastAbove = fast.compareTo(slow) > 0;
    const prev = this.crossState.get(symbol);

    if (prev !== null && prev !== undefined && prev !== nowFastAbove) {
      // A cross just happened (state flipped).
      if (nowFastAbove) {
        // Golden cross. If we're flat, open long.
        if (position.quantity.isZero()) {
          this.crossState.set(symbol, nowFastAbove);
          return signal(symbol, 'BUY', {
            confidence: 0.6,
            reason: `fast MA (${this.fastPeriod}) crossed above slow MA (${this.slowPeriod})`,
          }, nowMs);
        }
      } else {
        // Death cross. If we hold a long, exit (SELL).
        if (position.quantity.isPositive()) {
          this.crossState.set(symbol, nowFastAbove);
          return signal(symbol, 'SELL', {
            confidence: 0.6,
            reason: `fast MA (${this.fastPeriod}) crossed below slow MA (${this.slowPeriod})`,
          }, nowMs);
        }
      }
    }

    // No transition, or we're not in a state that warrants acting. Record state
    // on first evaluation so the next tick can detect a transition.
    this.crossState.set(symbol, nowFastAbove);
    return signal(symbol, 'HOLD', { reason: 'no cross' }, nowMs);
  }

  describe(): string {
    return `MovingAverageCrossover(fast=${this.fastPeriod}, slow=${this.slowPeriod}, timeframe=${this.timeframe})`;
  }
}

// Self-registration: importing this module (directly, via index.ts, or via the
// registry factory) makes the strategy available to createStrategy(). Mirror of
// the NDAX adapter's self-registration in the exchange registry.
registerStrategy('moving-average-crossover', (params: StrategyRegistryParams) => {
  const fast = typeof params.fastPeriod === 'number' ? params.fastPeriod : 10;
  const slow = typeof params.slowPeriod === 'number' ? params.slowPeriod : 30;
  return new MovingAverageCrossoverStrategy(params.timeframe, { fastPeriod: fast, slowPeriod: slow });
});
