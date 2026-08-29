/**
 * Portfolio domain types.
 *
 * The portfolio tracks cash, open positions (with average entry price, cost
 * basis, and per-position realized P&L), aggregate realized P&L and fees, and
 * the peak equity used for drawdown. Everything is `Money` (fixed-point BigInt)
 * — no floating-point financial math.
 */

import type { Money } from '../money/Money.js';

/** A single open (long) position. V1 is long-only. */
export interface PaperPosition {
  symbol: string;
  /** Net quantity in base units (>= 0). */
  quantity: Money;
  /** Average entry price (quote per base unit), including fees on entry. */
  averageEntryPrice: Money;
  /** Remaining cost basis (quote) attributable to the held quantity. */
  costBasis: Money;
  /** Realized P&L (quote) from sells against this position. */
  realizedPnl: Money;
  /** Total fees (quote) paid on this position's buys/sells. */
  feesPaid: Money;
}

/**
 * Immutable-ish portfolio state. Mutating methods on `Portfolio` return a new
 * `PortfolioModel` (functional style) so state changes are explicit and easy to
 * persist/log.
 */
export interface PortfolioModel {
  /** Available cash by currency (quote/settlement currencies). */
  cash: Map<string, Money>;
  /** Open positions by symbol. */
  positions: Map<string, PaperPosition>;
  /** Peak aggregate equity (quote), for drawdown calculations. */
  peakEquity: Money;
  /** Aggregate realized P&L (quote) across all positions. */
  realizedPnl: Money;
  /** Aggregate fees paid (quote) across all trades. */
  totalFees: Money;
}

/** A currency amount produced by an execution fill (cash delta). */
export interface CashFlow {
  currency: string;
  amount: Money;
}
