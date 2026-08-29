/**
 * RiskContext — the read-only account/market snapshot a risk decision is made
 * against.
 *
 * The RiskManager performs no I/O. It evaluates a fully-constructed snapshot,
 * which the engine assembles from market data and account reads. Any required
 * field left `null` forces a fail-closed rejection rather than a guess.
 */

import type { Money } from '../money/Money.js';
import type { Signal } from '../strategy/Signal.js';
import type { MarketInfo, SymbolStr } from '../types.js';
import type { Balance } from '../types.js';

export interface RiskContext {
  symbol: SymbolStr;
  /** The signal under evaluation (BUY / SELL / HOLD). */
  signal: Signal;
  /** Logical "now" for this decision. */
  nowMs: number;
  /** Timestamp of the market data snapshot, for staleness checks. */
  marketDataTimestampMs: number | null;
  /** Reference price for the symbol (ask/last for BUY, bid/last for SELL). */
  price: Money | null;
  /** Exchange market metadata (tick sizes, min quantity, precision). */
  marketInfo: MarketInfo | null;
  /** Available balance in the quote (settlement) currency. */
  quoteBalance: Balance | null;
  /** Current portfolio equity (quote currency). */
  portfolioValue: Money | null;
  /** Peak portfolio equity (quote currency), for drawdown. */
  peakPortfolioValue: Money | null;
  /** Total open position notional across the whole portfolio (quote), before this trade. */
  portfolioExposure: Money | null;
  /** This symbol's net position in base units (>= 0 for the long-only V1). */
  currentPosition: Money | null;
  /** Realized P&L today (quote currency). Negative = loss. */
  realizedPnlToday: Money | null;
  /** Unrealized P&L today (quote currency). Negative = loss. */
  unrealizedPnlToday: Money | null;
}
