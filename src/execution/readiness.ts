/**
 * First-live-BUY readiness gate (Gate 7.4).
 *
 * This is a READ-ONLY, pure evaluator. It never submits, cancels, or mutates any
 * state: it only inspects a set of pre-assessed conditions and answers whether
 * RETRAC may safely proceed with a single, operator-confirmed live BUY.
 *
 * Fail-closed design (the safety principle):
 *   - Every condition must be demonstrably TRUE (pass).
 *   - `null` means "UNKNOWN — cannot be established from current evidence" and is
 *     treated exactly like a failure: the gate BLOCKS live BUY. Unknown is never
 *     converted into "assume OK."
 *   - The gate is exchange-agnostic. The NDAX-specific facts (e.g. whether a
 *     trustworthy execution/fill identity or a trustworthy lost-ack re-attachment
 *     mechanism exists) are supplied by the caller from the repository's actual
 *     NDAX evidence; where that evidence is absent, they are `null`/false and the
 *     gate correctly returns NOT_READY.
 *
 * Gate 7.3 concluded NDAX gives no provably-unique re-attachment and Gate 7.2
 * requires a trustworthy `executionId` — neither is currently VERIFIED, so the
 * NDAX input for `reattachmentTrustworthy` and `executionIdentityTrustworthy` is
 * NOT true, and this gate blocks the first live BUY.
 */

export type ConditionStatus = 'PASS' | 'BLOCKED';

export interface ReadinessCondition {
  /** Stable id (also a key in `LiveBuyReadinessInput`). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** PASS, or BLOCKED (false / null-unknown). */
  status: ConditionStatus;
  /** Whether the value was UNKNOWN (null) rather than known-false. */
  unknown: boolean;
  /** Human-readable detail. */
  detail: string;
}

export type ReadinessVerdict = 'READY' | 'NOT_READY';

export interface LiveBuyReadinessReport {
  verdict: ReadinessVerdict;
  conditions: ReadinessCondition[];
  /** Ids of the conditions whose status is not PASS. */
  blockers: string[];
  /** True only when every required condition passed. */
  liveBuyAllowed: boolean;
}

/**
 * Pre-assessed facts about a would-be live BUY. `boolean | null` where `null`
 * means the fact is NOT yet established (unknown) and must block.
 */
export interface LiveBuyReadinessInput {
  /** Operator explicitly confirmed this specific live BUY. */
  operatorConfirmed: boolean | null;
  /** `adapter.capabilities.supportsOrderPlacement === true`. */
  adapterSupportsOrderPlacement: boolean | null;
  /** exchange auth + account-balance + MarketInfo reads are verified working. */
  adapterReadyVerified: boolean | null;
  /** Fresh market snapshot; quote + transport freshness both valid. */
  snapshotFresh: boolean | null;
  /** Portfolio-wide valuation valid (every managed position priced, fresh). */
  portfolioValuationValid: boolean | null;
  /** Reconciliation `safeToTrade === true`. */
  reconciliationSafeToTrade: boolean | null;
  /** No unresolved UNKNOWN orders in the ledger. */
  noUnresolvedUnknownOrders: boolean | null;
  /** No conflict between local order ownership and exchange open orders. */
  noOrderOwnershipConflict: boolean | null;
  /** Exchange available quote provably covers the order. */
  exchangeQuoteSufficient: boolean | null;
  /** Bot managed cash (net of reservations) covers the order. */
  managedCashSufficient: boolean | null;
  /** Order quantity positive, on the tick grid, >= minimum. */
  orderQuantityValid: boolean | null;
  /** Reference price present and fresh (ask??last for a BUY). */
  referencePriceValid: boolean | null;
  /** Estimated fee is covered by the reservation. */
  feeCovered: boolean | null;
  /** A durable, restart-safe logical order/intent identity is present & persisted. */
  durableOrderIdentity: boolean | null;
  /** A trustworthy (exchange-proven) lost-ack re-attachment mechanism exists. */
  reattachmentTrustworthy: boolean | null;
  /** A trustworthy (exchange-proven) execution/fill identity source exists. */
  executionIdentityTrustworthy: boolean | null;
}

const CONDITIONS: { id: keyof LiveBuyReadinessInput; label: string; requiredForLiveBuy: boolean }[] = [
  { id: 'operatorConfirmed', label: 'operator explicitly confirmed this live BUY', requiredForLiveBuy: true },
  { id: 'adapterSupportsOrderPlacement', label: 'adapter supports order placement', requiredForLiveBuy: true },
  { id: 'adapterReadyVerified', label: 'adapter auth / balances / submission format verified', requiredForLiveBuy: true },
  { id: 'snapshotFresh', label: 'market/account snapshot is fresh (quote + transport)', requiredForLiveBuy: true },
  { id: 'portfolioValuationValid', label: 'full-managed-portfolio valuation valid (no missing/stale)', requiredForLiveBuy: true },
  { id: 'reconciliationSafeToTrade', label: 'reconciliation safeToTrade', requiredForLiveBuy: true },
  { id: 'noUnresolvedUnknownOrders', label: 'no unresolved UNKNOWN orders', requiredForLiveBuy: true },
  { id: 'noOrderOwnershipConflict', label: 'no local/exchange order ownership conflict', requiredForLiveBuy: true },
  { id: 'exchangeQuoteSufficient', label: 'exchange available quote covers the order', requiredForLiveBuy: true },
  { id: 'managedCashSufficient', label: 'managed cash (net of reservations) covers the order', requiredForLiveBuy: true },
  { id: 'orderQuantityValid', label: 'order quantity valid (tick grid, >= min)', requiredForLiveBuy: true },
  { id: 'referencePriceValid', label: 'reference price present and fresh', requiredForLiveBuy: true },
  { id: 'feeCovered', label: 'estimated fee covered by reservation', requiredForLiveBuy: true },
  { id: 'durableOrderIdentity', label: 'durable, restart-safe logical order identity', requiredForLiveBuy: true },
  { id: 'reattachmentTrustworthy', label: 'trustworthy lost-ack re-attachment mechanism', requiredForLiveBuy: true },
  { id: 'executionIdentityTrustworthy', label: 'trustworthy execution/fill identity source', requiredForLiveBuy: true },
];

/**
 * Evaluate every condition. A condition passes only if its value is strictly
 * `true`; `false` and `null` (unknown) both BLOCK. Returns the report.
 */
export function evaluateLiveBuyReadiness(input: LiveBuyReadinessInput): LiveBuyReadinessReport {
  const conditions: ReadinessCondition[] = [];
  const blockers: string[] = [];
  for (const c of CONDITIONS) {
    const raw: boolean | null | undefined = input[c.id];
    const status: ConditionStatus = raw === true ? 'PASS' : 'BLOCKED';
    const unknown = raw === null || raw === undefined;
    if (status !== 'PASS') blockers.push(c.id);
    conditions.push({
      id: c.id,
      label: c.label,
      status,
      unknown,
      detail: status === 'PASS' ? 'verified/passed' : unknown ? 'UNKNOWN — not established' : 'not satisfied',
    });
  }
  const ready = blockers.length === 0;
  return {
    verdict: ready ? 'READY' : 'NOT_READY',
    conditions,
    blockers,
    liveBuyAllowed: ready,
  };
}

/**
 * The NDAX-specific readiness facts, grounded in the repository's actual NDAX
 * evidence (docs/NDAX_API.md + `src/exchanges/ndax/*`). Returns `null` (unknown)
 * for capabilities that are NOT yet VERIFIED in this repository, so the gate
 * fail-closes rather than assuming support.
 */
export function ndaxLiveBuyFacts(): Pick<LiveBuyReadinessInput, 'adapterReadyVerified' | 'reattachmentTrustworthy' | 'executionIdentityTrustworthy' | 'noOrderOwnershipConflict'> {
  return {
    // OrderId is unique but ClientOrderId is not; no verified re-attachment path
    // for a lost-ack order (Gate 7.3).
    reattachmentTrustworthy: null, // UNKNOWN: no provably-unique NDAX recovery mechanism
    // Gate 9.2 live-verified: GetAccountTrades exposes a stable `executionId`,
    // but its UNIVERSAL uniqueness is NOT proven (small sample), one-order->many-
    // executions was NOT observed, and it cannot reliably enumerate a specific
    // order's executions (paginated, not filterable by orderId). So a trustworthy
    // execution identity is STILL not established => remains UNKNOWN (block).
    executionIdentityTrustworthy: null, // UNKNOWN: executionId observed but uniqueness/per-order lookup unproven
    // Auth + balances reads are implemented but not live-verified (docs NDAX_API.md).
    adapterReadyVerified: null, // UNKNOWN: not verified against a live account
    // Local-vs-exchange order ownership is checked by reconciliation.
    noOrderOwnershipConflict: null, // UNKNOWN until a live reconciliation proves clean
  };
}
