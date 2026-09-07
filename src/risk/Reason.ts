/**
 * Risk decision reason codes and result types.
 *
 * Every risk decision carries a typed reason code, never just a free-form
 * string, so logs, persistence, and debugging can rely on a stable enum while
 * still showing a human-readable detail when useful.
 */

import type { Money } from '../money/Money.js';
import type { OrderSide } from '../order.js';
import type { SymbolStr } from '../types.js';

/** Typed, stable reasons a trade may be rejected (or accepted). */
export const RISK_REASON = [
  // --- Fail-closed / operational ---
  'KILL_SWITCH_ACTIVE',
  'STALE_MARKET_DATA',
  'UNKNOWN_PRICE',
  'UNKNOWN_BALANCE',
  'UNKNOWN_POSITION',
  'UNKNOWN_PORTFOLIO_VALUE',
  'UNKNOWN_PEAK',
  'UNKNOWN_PNL',
  'UNKNOWN_MARKET_INFO',
  'UNKNOWN_EXPOSURE',

  // --- Limit violations ---
  'DAILY_LOSS_LIMIT_EXCEEDED',
  'MAX_DRAWDOWN_EXCEEDED',
  'MAX_POSITION_EXCEEDED',
  'MAX_PORTFOLIO_EXPOSURE_EXCEEDED',
  'MAX_TRADE_EXCEEDED',
  'COOLDOWN_ACTIVE',
  'INSUFFICIENT_BALANCE',

  // --- Order / market validation ---
  'INVALID_QUANTITY',
  'BELOW_MIN_QUANTITY',
  'PRECISION_VIOLATION',

  // --- Intent ---
  'NO_ACTION', // HOLD signal, or a SELL when there is nothing to sell
  'SELL_EXCEEDS_POSITION', // SELL that would go short / exceed the held long
  'INVALID_SELL_TARGET', // malformed/empty bounded sell target (fraction/notional)
  'SELL_EXCEEDS_MANAGED_POSITION', // SELL that would sell EXTERNAL (non-bot) inventory
  'MAX_OPEN_POSITIONS', // BUY would open more managed positions than maxOpenPositions

  // --- Approvals ---
  'APPROVED',
] as const;

export type RiskReason = (typeof RISK_REASON)[number];

/** Snapshot of the risk limits that governed an approved decision. */
export interface AppliedRiskLimits {
  /** Per-trade cap on notional (quote). Zero = no explicit per-trade cap. */
  maxTradeAmount: Money;
  /** Max position as a fraction of portfolio value. */
  maxPositionSizeFraction: number;
  /** Max total portfolio exposure as a fraction of portfolio value. */
  maxPortfolioExposureFraction: number;
  /** Daily loss limit as a fraction of portfolio value. */
  maxDailyLossFraction: number;
  /** Max drawdown as a fraction of peak portfolio value. */
  maxDrawdownFraction: number;
  /** Cooldown after a loss, in ms. Zero = disabled. */
  cooldownAfterLossMs: number;
  /** Max open bot-managed positions. 0 = no limit. */
  maxOpenPositions: number;
  /** Whether the kill switch is currently active. */
  killSwitchActive: boolean;
}

export interface RiskApproval {
  approved: true;
  symbol: SymbolStr;
  side: OrderSide;
  /** Approved order quantity in base units. */
  quantity: Money;
  /** Approved notional (quantity * price) in quote currency. */
  estimatedNotional: Money;
  /** The reference price used to size the order. */
  price: Money;
  reason: 'APPROVED';
  /** The limits that applied to (and bounded) this sizing. */
  appliedLimits: AppliedRiskLimits;
}

export interface RiskRejection {
  approved: false;
  symbol: SymbolStr;
  /** The side requested, if any (null when there is nothing to act on). */
  side: OrderSide | null;
  reason: RiskReason;
  /** Optional human-readable clarification for logs. */
  detail?: string;
  /** The limits that were evaluated. */
  appliedLimits: AppliedRiskLimits;
}

export type RiskDecision = RiskApproval | RiskRejection;
