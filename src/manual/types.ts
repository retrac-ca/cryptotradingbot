/**
 * Manual-execution bridge domain types (Gate 9).
 *
 * A manual trade intent is RETRAC's durable RECOMMENDATION for a trade that the
 * OPERATOR executes EXTERNALLY on the exchange's authoritative interface. The
 * bridge NEVER submits an order and NEVER fights the exchange; it only:
 *   1. evaluates a candidate with the normal risk controls,
 *   2. records a durable proposed trade (intent) + the risk snapshot that
 *      governed it,
 *   3. captures the operator-returned execution evidence,
 *   4. validates that evidence as far as technically possible,
 *   5. accounts the external result ONLY through the distinct, operator-
 *      reviewed ORDER-LEVEL manual-accounting path (Portfolio.settleManualOrder),
 *   6. reconciles with the exchange.
 *
 * Identity separation (never conflated here):
 *   - intentId   : RETRAC logical order-intent identity (durable, local).
 *   - exchange OrderId : the exchange order identity, captured as evidence.
 *   - exchange ClientOrderId : NDAX long integer, non-unique; NOT an identity.
 *   - execution identity : per-fill identity. NDAX's documented/verified surface
 *      provides none, so the bridge NEVER claims/fabricates one; order-level
 *      accounting does not require one.
 */

import type { Money } from '../money/Money.js';
import type { OrderSide, OrderStatus, OrderTif, OrderType } from '../order.js';
import type { SymbolStr } from '../types.js';
import type { AppliedRiskLimits, RiskDecision } from '../risk/Reason.js';

/**
 * Lifecycle of a manual trade intent (state machine).
 *
 * Gate 9.5 splits the old conflated `SETTLED` into two explicit ACCOUNTED states
 * plus a distinct RECONCILIATION_REQUIRED, so that accounting authority,
 * exchange evidence, operator attribution and provenance are never conflated:
 *
 *  - `ACCOUNTED_WITH_EXCHANGE_VALIDATION`: RETRAC completed accounting using
 *    AUTHORITATIVE EXCHANGE evidence sufficient for the accounting performed
 *    (including an authoritative quote fee where a fee exists). The external
 *    order was consistency-validated. This does NOT imply provenance proof.
 *  - `ACCOUNTED_WITH_OPERATOR_ATTESTATION`: RETRAC completed accounting after an
 *    explicit human operator attestation identifying the external OrderId, with
 *    authoritative exchange consistency validation; accounting depends on
 *    operator attestation for intent-to-order attribution. Exchange provenance is
 *    NOT proven.
 *  - `RECONCILIATION_REQUIRED`: RETRAC has evidence that may represent an external
 *    execution but cannot safely determine/complete the accounting (e.g. fee
 *    currency unknown when a fee exists, incomplete execution enumeration,
 *    missing/unrelated OrderId, or a read failure). NO automatic accounting is
 *    applied; reservation/managed inventory stays conservative until a safe
 *    deterministic resolution occurs. This is DISTINCT from `AMBIGUOUS`.
 *  - `AMBIGUOUS`: evidence actually CONTRADICTS, or multiple interpretations are
 *    possible such that RETRAC cannot safely determine the state. It is NOT a
 *    generic synonym for "fee unavailable".
 */
export const MANUAL_INTENT_STATUS = [
  'PROPOSED', // created from a risk-approved recommendation; not yet operator-confirmed
  'CONFIRMED', // operator confirmed the proposal; operator may now execute externally
  'EVIDENCE_RECORDED', // operator recorded external execution evidence
  'PENDING', // external order is not yet terminal (open/partial, may still fill); reservation retained
  'ACCOUNTED_WITH_EXCHANGE_VALIDATION', // terminal accounting via authoritative exchange evidence
  'ACCOUNTED_WITH_OPERATOR_ATTESTATION', // terminal accounting via operator attestation (not proven provenance)
  'RECONCILIATION_REQUIRED', // consistent evidence but accounting cannot be safely completed; reservation retained
  'CANCELED', // terminal non-fill, or operator canceled before execution
  'VOID', // invalidated by RETRAC on a contradiction; reservation released
  'AMBIGUOUS', // evidence contradictory/unresolvable; reservation stays reserved
] as const;
export type ManualIntentStatus = (typeof MANUAL_INTENT_STATUS)[number];

/** The two terminal ACCOUNTED states (idempotent, no re-accounting). */
export const MANUAL_ACCOUNTED_STATUSES = [
  'ACCOUNTED_WITH_EXCHANGE_VALIDATION',
  'ACCOUNTED_WITH_OPERATOR_ATTESTATION',
] as const;
export type ManualAccountedStatus = (typeof MANUAL_ACCOUNTED_STATUSES)[number];

/** Terminal manual states: accounted, or definitively not-executed. */
export const MANUAL_TERMINAL_STATUSES = [...MANUAL_ACCOUNTED_STATUSES, 'CANCELED', 'VOID'] as const;

/** Blocked manual states holding a conservative reservation; never auto-resolved. */
export const MANUAL_BLOCKED_STATUSES = ['AMBIGUOUS', 'RECONCILIATION_REQUIRED'] as const;

export function isAccountedStatus(s: ManualIntentStatus): s is ManualAccountedStatus {
  return s === 'ACCOUNTED_WITH_EXCHANGE_VALIDATION' || s === 'ACCOUNTED_WITH_OPERATOR_ATTESTATION';
}

export function isTerminalManualStatus(s: ManualIntentStatus): boolean {
  return s === 'CANCELED' || s === 'VOID' || isAccountedStatus(s);
}

export function isBlockedManualStatus(s: ManualIntentStatus): boolean {
  return s === 'AMBIGUOUS' || s === 'RECONCILIATION_REQUIRED';
}

/** Where reported evidence origin came from. */
export const EVIDENCE_SOURCE = [
  'operator', // typed/asserted by the operator (never authoritative on its own)
  'exchange_read', // retrieved from an authoritative exchange read
  'ndax_ui', // copied from the NDAX web/app interface by the operator
  'ndax_api', // retrieved from the NDAX REST/WS API surface
  'other',
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCE)[number];

/**
 * Immutable snapshot of the risk facts that governed an approved proposal. This
 * is recorded so a later review/audit can see HOW the intent was sized and why,
 * independent of subsequent market movement.
 */
export interface ManualRiskSnapshot {
  symbol: SymbolStr;
  side: OrderSide;
  type: OrderType;
  referencePrice: Money;
  estimatedNotional: Money;
  estimatedFee: Money;
  quoteCurrency: string;
  /** Estimated total quote needed to fund the order (notional + fee, BUY). */
  requiredBalance: Money;
  deployableQuoteAtProposal: Money;
  portfolioValueAtProposal: Money;
  peakPortfolioValueAtProposal: Money;
  portfolioExposureAtProposal: Money;
  currentPositionAtProposal: Money;
  openManagedPositionCountAtProposal: number;
  appliedLimits: AppliedRiskLimits;
  marketDataTimestampMs: number | null;
  marketDataObservedAtMs: number;
  proposalTimeMs: number;
}

/** Operator-returned external execution evidence. NOT authoritative on its own. */
export interface ManualEvidence {
  /** External exchange OrderId, if the operator obtained one. */
  orderId: string | null;
  /** Exchange-reported order status (as the operator obtained it). */
  status: OrderStatus | null;
  /** Exchange-reported aggregate filled quantity (base units). */
  filledQuantity: Money | null;
  /** Exchange-reported average fill price (quote per base). */
  averagePrice: Money | null;
  /** Exchange-reported total fee for the order (quote), if known. */
  fee: Money | null;
  feeCurrency: 'base' | 'quote';
  evidenceSource: EvidenceSource;
  /** Local wall-clock time the evidence was recorded. */
  recordedAtMs: number;
  /** Optional human note (never trusted as financial data). */
  note?: string;
}

/** An immutable audit-trail event on an intent. */
export interface ManualEvent {
  ts: number;
  /** Machine action identifier, e.g. 'propose' | 'confirm' | 'evidence' | 'settle'. */
  type: string;
  actor: 'operator' | 'system';
  detail?: string;
}

/** A durable manual trade intent. */
export interface ManualTradeIntent {
  /** RETRAC logical order-intent identity (durable). */
  intentId: string;
  status: ManualIntentStatus;
  symbol: SymbolStr;
  side: OrderSide;
  type: OrderType;
  /** Risk-approved proposed quantity (base units). */
  quantity: Money;
  /** Optional limit price the operator/strategy intended; null for a market intent. */
  limitPrice: Money | null;
  tif: OrderTif | null;
  reason: string;
  riskSnapshot: ManualRiskSnapshot;
  /** The currently-recorded evidence, or null before any evidence is recorded. */
  evidence: ManualEvidence | null;
  /** Operator identity/acknowledgement that confirmed the proposal. */
  operatorConfirmedBy: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  events: ManualEvent[];
  /** Quote currency reserved for this BUY intent (BUY only), if any. */
  reservationCurrency: string | null;
  /** Reserved quote amount (BUY only), if any. */
  reservationAmount: Money | null;
}

/** Outcome of a proposal evaluation. */
export type ProposalResult =
  | { ok: true; intent: ManualTradeIntent }
  | { ok: false; reason: string; decision: RiskDecision };

/** Inputs to the bridge `propose` step beyond the RiskContext. */
export interface ManualProposeOptions {
  reason: string;
  /** Optional bound for a SELL (fraction and/or notional cap). */
  sellTarget?: { fraction?: number; notional?: Money } | null;
  /** Optional limit price; null = market-style intent. */
  limitPrice?: Money | null;
  /** Optional quote-notional cap for a BUY proposal. */
  buyNotionalCap?: Money | null;
}

/** Inputs to capture/update evidence. */
export interface RecordEvidenceInput {
  orderId?: string | null;
  status?: OrderStatus | null;
  filledQuantity?: Money | null;
  averagePrice?: Money | null;
  fee?: Money | null;
  feeCurrency?: 'base' | 'quote';
  evidenceSource?: EvidenceSource;
  note?: string;
}

/** Outcome of a settlement attempt. */
export type SettleOutcome =
  | { outcome: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION'; intent: ManualTradeIntent; settlement: import('../portfolio/types.js').ManualSettlement }
  | { outcome: 'ACCOUNTED_WITH_OPERATOR_ATTESTATION'; intent: ManualTradeIntent; settlement: import('../portfolio/types.js').ManualSettlement }
  | { outcome: 'CANCELED_TERMINAL_NO_FILL'; intent: ManualTradeIntent; reason: string }
  | { outcome: 'PENDING'; intent: ManualTradeIntent; reason: string }
  | { outcome: 'RECONCILIATION_REQUIRED'; intent: ManualTradeIntent; reason: string }
  | { outcome: 'AMBIGUOUS'; intent: ManualTradeIntent; reason: string }
  | { outcome: 'REFUSED'; intent: ManualTradeIntent; reason: string };

/**
 * The AUTHORITY that dictated the accounting, recorded explicitly so an
 * `ACCOUNTED_*` state is never mistaken for provenance proof.
 * - `'exchange'`: the recorded numbers came from authoritative exchange evidence.
 * - `'operator_attestation'`: the recorded numbers are attributed via an explicit
 *   human operator attestation (exchange consistency still validated).
 * Either way `provenanceProof` is always `false`.
 */
export type AccountingAuthority = 'exchange' | 'operator_attestation';

/** Severity of a reconciliation inconsistency. */
export type ManualReconcileSeverity = 'error' | 'warning';

/**
 * A single inconsistency found by `ManualTradeBridge.reconcile`.
 *
 * `fixed === true` means the bridge deterministically repaired it (e.g. an
 * intent whose settlement is already recorded but whose status was not yet
 * SETTLED, or a reservation leaked by a terminal no-fill intent). A `false`
 * issue was only reported — the bridge never fabricates a fill and never
 * auto-releases a reservation where a positive external execution may exist.
 */
export interface ManualReconcileIssue {
  type: string;
  intentId: string | null;
  severity: ManualReconcileSeverity;
  detail: string;
  /** True when the issue was deterministically repaired by this pass. */
  fixed: boolean;
}

/** Result of a deterministic recovery/reconciliation pass. */
export interface ManualReconcileReport {
  issues: ManualReconcileIssue[];
  /** The subset of `issues` that were deterministically repaired. */
  fixesApplied: ManualReconcileIssue[];
  /**
   * False if any ERROR-level inconsistency remains that would make automatic
   * manual accounting unsafe. Recovery is fail-closed; the operator must resolve
   * every error before the bridge is considered consistent.
   */
  safeToTrade: boolean;
}
