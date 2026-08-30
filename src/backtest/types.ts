/**
 * Backtest domain types.
 *
 * A backtest replays historical candles through the same strategy -> risk ->
 * execution pipeline used for live/paper trading, but with simulated execution
 * against historical prices. It produces a metrics report describing how the
 * strategy would have performed over the historical window.
 *
 * IMPORTANT: backtest results are a HISTORICAL SIMULATION driven by the exact
 * candles fed in. They are NOT a prediction of future performance. A
 * strategy-specific backtest is not a substitute for forward paper trading.
 */

import type { Money } from '../money/Money.js';
import type { Timeframe } from '../types.js';

export interface BacktestConfig {
  symbol: string;
  timeframe: Timeframe;
  /** Initial cash in the quote currency. */
  initialCash: Money;
  /** Quote currency, e.g. 'CAD' for 'BTC/CAD'. */
  quoteCurrency: string;
  /** Fee fraction per trade (e.g. 0.002 = 0.2%). */
  feeFraction: number;
  /** Slippage fraction applied against the reference (close) price. */
  slippageFraction: number;
  /** Optional cap on candles to replay (for faster/larger datasets). */
  maxCandles?: number;
}

/** A single recorded trade in the backtest (opening a position). */
export interface BacktestTrade {
  index: number;
  side: 'BUY' | 'SELL';
  quantity: Money;
  price: Money;
  fee: Money;
  notional: Money;
  timestampMs: number;
}

/** Rejection = a trade the strategy wanted but risk refused. */
export interface BacktestRejection {
  index: number;
  side: 'BUY' | 'SELL';
  reason: string;
  timestampMs: number;
}

/** Performance metrics required for a useful backtest report. */
export interface BacktestMetrics {
  candles: number;
  startingCapital: Money;
  endingCapital: Money;
  totalReturnFraction: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  realizedPnl: Money;
  feesPaid: Money;
  maxDrawdownFraction: number;
  largestWin: Money;
  largestLoss: Money;
}

export interface BacktestResult {
  config: BacktestConfig;
  metrics: BacktestMetrics;
  equityCurve: { timestampMs: number; equity: Money }[];
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  finalQuoteCash: Money;
  finalPositionQty: Money;
}
