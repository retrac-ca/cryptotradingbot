/**
 * Backtest domain types (Backtesting V1).
 *
 * A backtest replays historical candles through the existing `Strategy` ->
 * `RiskManager` -> `Portfolio` pipeline with a DETERMINISTIC, conservative,
 * single-symbol / single-timeframe simulated execution. It produces an auditable
 * result (trades, rejections, equity curve, metrics).
 *
 * IMPORTANT: backtest results are a HISTORICAL SIMULATION driven by the exact
 * candles fed in. They are NOT a prediction of future performance and do NOT
 * imply live-trading readiness.
 */

import type { Money } from '../money/Money.js';
import type { Timeframe } from '../types.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { RiskManager } from '../risk/RiskManager.js';

/**
 * Explicit exchange market constraints required for tick/minimum-aware
 * simulation. These are NEVER invented: `priceTick` and `quantityTick` are
 * exchange-specific and must be supplied. `minOrderBase` may be `null` to mean
 * "no minimum is being enforced" (the only mathematically neutral nullable
 * field).
 */
export interface BacktestMarketConstraints {
  /** Required price tick size, strictly positive. */
  priceTick: Money;
  /** Required quantity tick size, strictly positive. */
  quantityTick: Money;
  /** Minimum order quantity in base units, or `null` when no minimum is enforced. */
  minOrderBase: Money | null;
}

/**
 * V1 fee model: a quote-denominated percentage of notional.
 *
 * V1 supports ONLY quote-denominated fees. A base-denominated fee is rejected
 * (fail closed) rather than silently converted to quote — the codebase has no
 * base-fee accounting path that is safe to auto-apply, and converting would
 * fabricate a fee currency. Simulated fees are a MODEL input, never exchange
 * evidence.
 */
export interface BacktestFeeModelRate {
  kind: 'rate';
  currency: 'quote';
  /** Fee fraction of notional (e.g. 0.002 = 0.2%). Non-negative. */
  rate: number;
}
export type BacktestFeeModel = BacktestFeeModelRate;

export interface BacktestConfig {
  /** Canonical symbol, e.g. "BTC/CAD". */
  symbol: string;
  timeframe: Timeframe;
  /** Initial cash in the quote currency. */
  initialCash: Money;
  /** Quote currency (must equal `symbol.split('/')[1]`). */
  quoteCurrency: string;
  /** Fee model. V1: quote-denominated rate only. */
  feeModel: BacktestFeeModel;
  /** Deterministic per-side slippage fraction (>= 0) applied at the fill. */
  slippageFraction: number;
  /** Explicit market constraints (ticks + minimum). */
  marketConstraints: BacktestMarketConstraints;
}

/**
 * The public, deterministic backtest boundary.
 *
 * The engine accepts FACTORIES (not pre-instantiated mutable objects) so the
 * `Strategy` and `RiskManager` state can never leak between runs. The engine
 * calls `createStrategy()` and `createRiskManager()` EXACTLY ONCE per run, uses
 * the returned instances for that run only, and discards them.
 */
export interface BacktestRunInput {
  /** Historical candles, strictly ascending by end-time, unique, valid OHLC. */
  candles: import('../types.js').Candle[];
  config: BacktestConfig;
  /** Factory returning a FRESH `Strategy` per call. */
  createStrategy: () => Strategy;
  /** Factory returning a FRESH `RiskManager` per call. */
  createRiskManager: () => RiskManager;
}

/** A single simulated fill (a pending order that executed completely). */
export interface BacktestTrade {
  /** Deterministic id: `bt-<symbol>-<barIndex>-<seq>-<side>`. */
  id: string;
  /** Candle index whose OPEN served as the fill price. */
  barIndex: number;
  /** Candle index whose CLOSE produced the decision that led to this fill. */
  signalBarIndex: number;
  side: 'BUY' | 'SELL';
  quantity: Money;
  /** Fill price (next-open + slippage, normalized to the price tick). */
  price: Money;
  notional: Money;
  fee: Money;
  feeCurrency: 'quote';
  /** Fill time (open time of `barIndex`). */
  timestampMs: number;
  /** Realized P&L for a SELL (quote); `null` for a BUY. */
  realizedPnl: Money | null;
}

/** A rejected order or risk decision. */
export interface BacktestRejection {
  /** Candle index where the rejection occurred. */
  barIndex: number;
  side: 'BUY' | 'SELL' | null;
  /** Stable typed reason code. */
  reason: string;
  /** Timestamp of the decision (close) or execution (open) that was rejected. */
  timestampMs: number;
  /** `'decision'` = RiskManager rejection; `'execution'` = fill-time safety rejection. */
  phase: 'decision' | 'execution';
}

export interface BacktestMetrics {
  /** Number of candles consumed. */
  barCount: number;
  startingCapital: Money;
  endingCapital: Money;
  /** endingCapital - startingCapital (quote). */
  absolutePnl: Money;
  totalReturnFraction: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  /** winningTrades / (winning + losing), 0 when no closed trades. */
  winRate: number;
  /** Sum of positive realized P&L (quote). */
  grossProfit: Money;
  /** Sum of absolute value of negative realized P&L (quote). */
  grossLoss: Money;
  feesPaid: Money;
  /** Peak-to-trough drawdown as a fraction of the running peak. */
  maxDrawdownFraction: number;
  peakEquity: Money;
  /** Most negative realized P&L (or zero). */
  largestLoss: Money;
  /** Largest positive realized P&L (or zero). */
  largestWin: Money;
  /** Peak total notional exposure (quote) across the run. */
  maxExposure: Money;
}

export interface BacktestResult {
  config: BacktestConfig;
  symbol: string;
  timeframe: Timeframe;
  /** First candle END time. */
  dataStartMs: number | null;
  /** Last candle END time. */
  dataEndMs: number | null;
  marketConstraints: BacktestMarketConstraints;
  feeModel: BacktestFeeModel;
  slippageFraction: number;
  trades: BacktestTrade[];
  rejections: BacktestRejection[];
  equityCurve: { timestampMs: number; equity: Money }[];
  metrics: BacktestMetrics;
  finalQuoteCash: Money;
  finalPositionQty: Money;
  warnings: string[];
  /** Constant label making the nature of the output explicit. */
  simulationLabel: string;
}
