/**
 * Reconciliation V1 result model.
 *
 * Reconciliation REDUCES uncertainty without inventing certainty. Findings are
 * produced by `reconcile()` (read-only). `commitProven()` applies ONLY
 * deterministic, PROVEN accounting. Every materially-different condition is kept
 * distinct; a result always explains WHY READY is (or is not) achievable.
 */

import type { Money } from '../money/Money.js';
import type { OrderSide } from '../order.js';
import type { AccountTrade } from '../types.js';

export type CorrelationLevel = 'PROVEN' | 'STRONG_BUT_NOT_PROVEN' | 'AMBIGUOUS' | 'UNCORRELATED';

/** Completeness of an order's execution set relative to exchange-reported quantity. */
export type Completeness = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';

export type FeeDisposition = 'QUOTE' | 'BASE' | 'UNKNOWN' | 'MALFORMED';

export type OrderDisposition = 'CONFIRMED' | 'PARTIALLY_CONFIRMED' | 'AMBIGUOUS' | 'MISSING' | 'CORRUPT' | 'OPERATOR_REQUIRED';

export type ReservationDisposition = 'RELEASE' | 'RETAIN' | 'AMBIGUOUS';

export type OperatorFindingKind =
  | 'OPERATOR_REQUIRED_AMBIGUOUS_ORDER'
  | 'OPERATOR_REQUIRED_MISSING_EXECUTION_ID'
  | 'OPERATOR_REQUIRED_INCOMPLETE_HISTORY'
  | 'OPERATOR_REQUIRED_FEE_CURRENCY'
  | 'OPERATOR_REQUIRED_BALANCE_DISCREPANCY'
  | 'OPERATOR_REQUIRED_CONTRADICTORY_EVIDENCE'
  | 'OPERATOR_REQUIRED_MANUAL_EVIDENCE_CONFLICT';

export interface ExecutionFinding {
  /** The exchange execution id (never fabricated). */
  executionId: string | null;
  /** The exchange OrderId the execution belongs to. */
  orderId: string | null;
  symbol: string | null;
  side: OrderSide;
  quantity: Money;
  price: Money;
  fee: Money;
  feeProductId: string | null;
  feeDisposition: FeeDisposition;
  correlation: CorrelationLevel;
  /** The local clientOrderId this execution is PROVEN to belong to, if any. */
  matchedClientOrderId: string | null;
  completeness: Completeness;
  reason: string;
}

export interface OrderFinding {
  clientOrderId: string;
  exchangeOrderId: string | null;
  localStatus: string;
  exchangeStatus: string | null;
  disposition: OrderDisposition;
  /** Exchange-reported executed quantity. */
  executedQuantity: Money;
  /** Sum of PROVEN execution quantities. */
  provenExecutedQuantity: Money;
  completeness: Completeness;
  reason: string;
}

export interface ReservationFinding {
  orderId: string;
  disposition: ReservationDisposition;
  reason: string;
}

export interface BalanceFinding {
  currency: string;
  expected: Money | null;
  observed: Money | null;
  mismatch: boolean;
  reason: string;
}

export interface OperatorFinding {
  kind: OperatorFindingKind;
  detail: string;
}

/** A PROVEN execution eligible for automatic accounting (commitProven). */
export interface CommitCandidate {
  clientOrderId: string;
  orderId: string;
  executionId: string;
  symbol: string;
  side: OrderSide;
  quantity: Money;
  price: Money;
  fee: Money;
  feeCurrency: 'quote';
}

/** A reservation release the existing safety rules prove safe. */
export interface ReservationRelease {
  orderId: string;
  reason: string;
}

export interface ReconciliationResult {
  status: 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED';
  reasons: string[];
  orderFindings: OrderFinding[];
  executionFindings: ExecutionFinding[];
  reservationFindings: ReservationFinding[];
  balanceFindings: BalanceFinding[];
  operatorFindings: OperatorFinding[];
  /** PROVEN executions eligible for commit (only when `canCommit`). */
  commitCandidates: CommitCandidate[];
  /** Reservations the safety rules prove safe to release. */
  reservationReleases: ReservationRelease[];
  /** True when at least one execution is PROVEN + QUOTE and may be committed. */
  canCommit: boolean;
}

/** A context object used to build an immutable ReconciliationResult. */
export interface ReconciliationSnapshot {
  orders: Map<string, import('../order.js').Order>;
  livePortfolio: import('../portfolio/Portfolio.js').Portfolio | null;
  manualIntents: Map<string, import('../manual/types.js').ManualTradeIntent>;
  exchange: {
    balances: import('../types.js').Balance[];
    openOrders: import('../order.js').Order[];
    orderHistory: import('../order.js').Order[];
    accountTrades: AccountTrade[];
    marketInfo: Map<string, import('../types.js').MarketInfo>;
  };
  fetchedAtMs: number;
}
