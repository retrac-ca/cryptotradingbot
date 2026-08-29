/**
 * Strategy — the abstraction for signal generation.
 *
 * A strategy is a pure, deterministic function of its `StrategyContext`: it
 * reads a frozen market-data + position snapshot and returns a `Signal`. It has
 * no way to place orders, access the exchange, or mutate state.
 *
 * The strategy is deliberately independent of NDAX and the execution engine.
 */

import type { Timeframe } from '../types.js';
import type { Signal } from './Signal.js';
import type { StrategyContext } from './StrategyContext.js';

export interface Strategy {
  /** Stable id used to select this strategy by config (e.g. "ma-crossover"). */
  readonly id: string;
  /** Human-readable name for logs/UX. */
  readonly name: string;
  /** The timeframe this strategy expects its candles in. */
  readonly timeframe: Timeframe;
  /** Number of candles needed before the strategy can produce a real signal. */
  readonly warmupCandles: number;

  /**
   * Evaluate one tick for a symbol and return a signal. Must be deterministic:
   * the same snapshot must yield the same signal. Must not throw for normal
   * data conditions; return HOLD when unsure or data is insufficient.
   */
  evaluate(context: StrategyContext): Signal;

  /** Human-readable description of parameters (for logs/config introspection). */
  describe(): string;
}
