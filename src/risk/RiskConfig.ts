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
  /** Maximum acceptable age of market data before a decision fails closed. */
  marketDataMaxAgeMs: number;
}
