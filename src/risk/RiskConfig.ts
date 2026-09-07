/**
 * Risk configuration — the limits the RiskManager enforces.
 *
 * This is deliberately separate from `BotConfig` so the RiskManager is a pure,
 * deterministic, testable unit that depends only on typed numbers/Money. The
 * config loader (and later the engine) is responsible for translating the
 * validated `BotConfig` into these values.
 */

import type { Money } from '../money/Money.js';

export interface RiskConfig {
  /**
   * Maximum notional (quote currency) permitted for a single trade.
   * Zero means "no explicit per-trade cap" (position/exposure limits still apply).
   */
  maxTradeAmount: Money;
  /** Maximum position per asset as a fraction of portfolio value. */
  maxPositionSizeFraction: number;
  /** Maximum total portfolio exposure as a fraction of portfolio value. */
  maxPortfolioExposureFraction: number;
  /** Daily loss limit as a fraction of portfolio value. */
  maxDailyLossFraction: number;
  /** Maximum drawdown as a fraction of peak portfolio value. */
  maxDrawdownFraction: number;
  /** Cooldown (ms) after a losing trade before new trades are allowed. Zero = off. */
  cooldownAfterLossMs: number;
  /** Maximum number of OPEN (bot-managed) positions. 0 = no limit. */
  maxOpenPositions: number;
  /** Maximum acceptable age of market data before a decision fails closed. */
  marketDataMaxAgeMs: number;
  /**
   * Maximum acceptable age of the local *observation* (transport/fetch) of the
   * snapshot before a decision fails closed. A fresh quote can still be held by
   * a late transport; both the quote age and this must pass.
   */
  marketDataTransportMaxAgeMs: number;
  /**
   * Max acceptable skew for a quote timestamp that is AHEAD of the local clock
   * before it is rejected as unreliable (`QUOTE_AHEAD_OF_CLOCK`). This is a
   * future-dating guard, NOT a widening of `marketDataMaxAgeMs`.
   */
  maxClockSkewMs: number;
}
