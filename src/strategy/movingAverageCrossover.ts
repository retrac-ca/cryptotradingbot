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

import type { Ticker } from '../types.js';
import { Money } from '../money/Money.js';
import type { StrategyContext, PositionView } from './StrategyContext.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './Signal.js';
import { signal } from './Signal.js';
import { sma } from './indicators.js';
import { registerStrategy, type StrategyRegistryParams } from './registry.js';

/** Resolve a fraction to an exact numerator over 1e9 (fixed-point, no floats). */
const FRACTION_SCALE = 1_000_000_000n;

export interface MovingAverageCrossoverParams {
  /** Fast SMA period (must be < slowPeriod). */
  fastPeriod: number;
  /** Slow SMA period. */
  slowPeriod: number;
  /**
   * Stop-loss fraction below the average entry price for an open long
   * (e.g. 0.05 = exit if price falls 5% below entry). `0` disables the stop.
   * Derived from the DURABLE position entry basis, so it survives a restart.
   */
  stopLossFraction?: number;
}

export class MovingAverageCrossoverStrategy implements Strategy {
  readonly id = 'moving-average-crossover';
  readonly name = 'Moving Average Crossover';
  readonly timeframe;
  readonly warmupCandles;
  readonly fastPeriod;
  readonly slowPeriod;
  readonly stopLossFraction;

  /** Per-symbol last known fast-vs-slow relationship (null until first computed). */
  private crossState = new Map<string, boolean | null>();

  constructor(timeframe: Strategy['timeframe'], params: MovingAverageCrossoverParams) {
    if (params.fastPeriod <= 0 || params.slowPeriod <= 0) {
      throw new Error('MA crossover periods must be positive integers.');
    }
    if (params.slowPeriod <= params.fastPeriod) {
      throw new Error('MovingAverageCrossover: slowPeriod must be greater than fastPeriod.');
    }
    const stop = params.stopLossFraction ?? 0;
    if (!Number.isFinite(stop) || stop < 0 || stop > 1) {
      throw new Error('MovingAverageCrossover: stopLossFraction must be a finite fraction in [0, 1].');
    }
    this.timeframe = timeframe;
    this.fastPeriod = params.fastPeriod;
    this.slowPeriod = params.slowPeriod;
    this.stopLossFraction = stop;
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

    // --- Exit an existing long. ---
    // This is LEVEL-based, not transition-based: a long is exited whenever the
    // fast MA is strictly below the slow MA (or the stop is breached), so a
    // transition missed while the process was offline can never strand a
    // position. On equality (fast === slow) the position is HELD.
    if (position.quantity.isPositive()) {
      const stopReason = this.stopLossReason(context, position);
      if (stopReason !== null) {
        this.crossState.set(symbol, nowFastAbove);
        return signal(symbol, 'SELL', { confidence: 0.6, reason: stopReason }, nowMs);
      }
      if (fast.compareTo(slow) < 0) {
        this.crossState.set(symbol, nowFastAbove);
        return signal(symbol, 'SELL', {
          confidence: 0.6,
          reason: `fast MA (${this.fastPeriod}) below slow MA (${this.slowPeriod})`,
        }, nowMs);
      }
      this.crossState.set(symbol, nowFastAbove);
      return signal(symbol, 'HOLD', { reason: 'holding long' }, nowMs);
    }

    // A negative/non-zero non-long quantity is never traded (V1 is long-only).
    if (!position.quantity.isZero()) {
      this.crossState.set(symbol, nowFastAbove);
      return signal(symbol, 'HOLD', { reason: 'non-flat position' }, nowMs);
    }

    // --- Flat: enter on a fresh golden cross (transition-based). ---
    const prev = this.crossState.get(symbol);
    this.crossState.set(symbol, nowFastAbove);
    if (prev === false && nowFastAbove) {
      return signal(symbol, 'BUY', {
        confidence: 0.6,
        reason: `fast MA (${this.fastPeriod}) crossed above slow MA (${this.slowPeriod})`,
      }, nowMs);
    }
    return signal(symbol, 'HOLD', { reason: 'no cross' }, nowMs);
  }

  /**
   * Stop-loss reason for an open long, or null when no stop applies.
   *
   * The threshold is derived from the DURABLE position average entry price
   * (which includes entry fees) and the configured fraction, so it is
   * deterministic and survives a process restart without any strategy memory.
   * A long with no positive entry basis (e.g. externally-authorized inventory
   * carried at zero cost) has no stop. The mark price is the ticker's last
   * traded price, falling back to bid/ask.
   */
  private stopLossReason(context: StrategyContext, position: PositionView): string | null {
    if (this.stopLossFraction <= 0) return null;
    const entry = position.averageEntryPrice;
    if (entry === null || !entry.isPositive()) return null;
    const price = markPrice(context.ticker);
    if (price === null) return null;
    const stopNumerator = FRACTION_SCALE - BigInt(Math.round(this.stopLossFraction * Number(FRACTION_SCALE)));
    const threshold = entry.mulFraction(stopNumerator, FRACTION_SCALE);
    if (price.compareTo(threshold) <= 0) {
      return `stop-loss: price ${price} <= threshold ${threshold} (entry ${entry}, stop ${this.stopLossFraction})`;
    }
    return null;
  }

  describe(): string {
    return `MovingAverageCrossover(fast=${this.fastPeriod}, slow=${this.slowPeriod}, timeframe=${this.timeframe}, stopLoss=${this.stopLossFraction})`;
  }
}

/** Best available mark price from a ticker snapshot, or null. */
function markPrice(ticker: Ticker | null): Money | null {
  if (!ticker) return null;
  const price = ticker.last ?? ticker.bid ?? ticker.ask;
  return price !== null && price.isPositive() ? price : null;
}

// Self-registration: importing this module (directly, via index.ts, or via the
// registry factory) makes the strategy available to createStrategy(). Mirror of
// the NDAX adapter's self-registration in the exchange registry.
registerStrategy('moving-average-crossover', (params: StrategyRegistryParams) => {
  const fast = typeof params.fastPeriod === 'number' ? params.fastPeriod : 10;
  const slow = typeof params.slowPeriod === 'number' ? params.slowPeriod : 30;
  const stopLossFraction = typeof params.stopLossFraction === 'number' ? params.stopLossFraction : 0;
  return new MovingAverageCrossoverStrategy(params.timeframe, { fastPeriod: fast, slowPeriod: slow, stopLossFraction });
});
