/**
 * StrategyContext — the read-only view a strategy receives on each evaluation.
 *
 * A strategy inspects this context and returns a `Signal`. It has NO access to
 * the exchange, orders, or execution engine, so a strategy can never place,
 * cancel, or mutate an order. All data is a snapshot frozen at evaluation time.
 */

import type { Candle, Ticker, Timeframe } from '../types.js';
import { Money } from '../money/Money.js';

/** Immutable snapshot of the current position the strategy is managing. */
export interface PositionView {
  symbol: string;
  /** Net position in base units. Zero = flat. */
  quantity: Money;
  /** Average entry price, if any base units are held. */
  averageEntryPrice: Money | null;
  /** Realized P&L this session in quote currency (informational). */
  realizedPnl: Money;
}

/**
 * Frozen snapshot of market data + position passed to Strategy.evaluate().
 */
export interface StrategyContext {
  /** Logical "now" for this evaluation tick. */
  nowMs: number;
  /** Symbol this evaluation targets. */
  symbol: string;
  /** Latest ticker snapshot, or null if none is available yet. */
  ticker: Ticker | null;
  /**
   * Candle series for the strategy's timeframe (already warm), oldest first.
   * May be shorter than the configured warm-up if not enough data exists yet.
   */
  candles: Candle[];
  /** The strategy's candle timeframe. */
  timeframe: Timeframe;
  /** Current position for this symbol (empty/zero when flat). */
  position: PositionView;
  /**
   * True when the candle series is too short to reach a confident decision
   * (e.g. below the strategy's warm-up requirement). Strategies typically
   * return HOLD in this case.
   */
  insufficientData: boolean;
}
