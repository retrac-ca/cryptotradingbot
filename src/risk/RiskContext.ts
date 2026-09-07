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
  /**
   * Exchange-reported quote time (ms epoch) for the snapshot, e.g. NDAX L1
   * `TimeStamp` or the newest L2 `ActionDateTime`. Distinguished from
   * `marketDataObservedAtMs`: this is WHEN the market said it was, not when we
   * fetched it.
   */
  marketDataTimestampMs: number | null;
  /**
   * Local wall-clock time (ms epoch) the market-data snapshot was
   * observed/fetched. Used with the quote time to fail closed on stale
   * TRANSPORT even when the quote itself looks fresh.
   */
  marketDataObservedAtMs: number | null;
  /** Reference price for the symbol (ask/last for BUY, bid/last for SELL). */
  price: Money | null;
  /** Exchange market metadata (tick sizes, min quantity, precision). */
  marketInfo: MarketInfo | null;
  /** Available balance in the quote (settlement) currency. */
  quoteBalance: Balance | null;
  /**
   * Quote the bot is authorized to deploy for new BUYs, net of capital already
   * reserved by in-flight bot orders. In the LIVE path this is bounded by the
   * exchange's AUTHORITATIVE AVAILABLE quote (total - held), so held/frozen
   * funds are never counted as deployable and the bot never deploys more than
   * its own managed quote (F-7). BUY funding must satisfy
   * `notional + estimatedFee <= deployableQuote`. Absent/null => risk fails
   * closed (UNKNOWN_BALANCE) for a BUY.
   */
  deployableQuote: Money | null;
  /** Current bot-MANAGED equity (quote). External holdings excluded. */
  portfolioValue: Money | null;
  /** Peak bot-MANAGED equity (quote), for drawdown. External holdings excluded. */
  peakPortfolioValue: Money | null;
  /** Total open bot-MANAGED position notional across the portfolio (quote). External excluded. */
  portfolioExposure: Money | null;
  /**
   * This symbol's net BOT-MANAGED position in base units (>= 0 for long-only V1).
   * EXTERNAL inventory is never included here: the bot may only trade what it
   * owns/authorizes, so SELL sizing and the position cap are bounded by this.
   */
  currentPosition: Money | null;
  /**
   * This symbol's EXTERNAL (non-bot) holdings, in base units. Used for the
   * SELL-ownership invariant: a SELL may never consume external inventory. Zero
   * when absent. This is informational/safety — it never becomes tradable.
   */
  externalPosition: Money | null;
  /**
   * Number of bot-managed open positions currently held (quantity > 0), used to
   * enforce `maxOpenPositions` on new BUYs. External holdings do not count.
   * Absent/null => treated as 0 (no extra restriction beyond config default).
   */
  openManagedPositionCount: number | null;
  /** Realized P&L today (quote currency). Negative = loss. */
  realizedPnlToday: Money | null;
  /** Unrealized P&L today (quote currency). Negative = loss. */
  unrealizedPnlToday: Money | null;
  /**
   * Optional bounded order-sizing intent for a risk-reducing SELL. When present
   * the RiskManager sells AT MOST this target (min of fraction/notional vs the
   * held position), i.e. a partial exit. Absent/null means a full exit of the
   * held position. This is a hedge/lab tool for the live-test command so the
   * operator can bound the fill WITHOUT ever injecting a raw quantity.
   */
  sellTarget?: { fraction?: number; notional?: Money } | null;
}
