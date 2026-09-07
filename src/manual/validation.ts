/**
 * Manual-execution evidence validation (Gate 9).
 *
 * Two independent layers, both fail closed:
 *   1. Structural — is the operator-supplied evidence internally consistent and
 *      well-formed (terminal state, filled <= proposed, positive price, fee >= 0)?
 *   2. Exchange — does the authoritative exchange read CONFIRM the order state,
 *      fill quantity, and average price? Operator input is never authoritative
 *      by itself; authority must come from the exchange (a `getOrderStatus` read).
 *
 * The bridge NEVER instructs the exchange, NEVER submits/cancels, and NEVER
 * fabricates an execution identity. The authoritative `Order` returned by an
 * exchange read carries the ORDER identity and aggregate state; per-fill
 * provenance is intentionally NOT attributed because NDAX's documented/verified
 * surface provides no trustworthy per-execution id.
 */

import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { Order, OrderStatus } from '../order.js';
import { Money } from '../money/Money.js';
import type { ManualEvidence, ManualTradeIntent } from './types.js';

/** Statuses from which no further fills can occur. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

/** Statuses that mean the order is NOT yet final (may still fill). */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'CREATED',
  'SUBMITTED',
  'OPEN',
  'PARTIALLY_FILLED',
]);

export function isTerminalStatus(status: OrderStatus | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_STATUSES.has(status);
}

export function isOpenStatus(status: OrderStatus | null | undefined): boolean {
  return status !== null && status !== undefined && OPEN_STATUSES.has(status);
}

/** A terminal no-fill is a terminal status where the aggregate fill is exactly 0. */
export function isTerminalNoFill(status: OrderStatus | null, filled: Money | null): boolean {
  if (!isTerminalStatus(status)) return false;
  if (filled === null) return false; // cannot confirm a no-fill without a reported fill amount
  return !filled.isPositive();
}

export type StructuralDisposition = 'SETTLABLE' | 'TERMINAL_NO_FILL' | 'PENDING' | 'INVALID';

export interface StructuralValidation {
  ok: boolean;
  disposition: StructuralDisposition;
  /** Human reason (present when not Settle/Pending). */
  reason?: string;
}

/**
 * Validate operator-supplied evidence for internal consistency.
 *
 * Conservative rules (never assume what was not reported):
 *   - NO status reported            => PENDING (cannot decide).
 *   - OPEN/PARTIALLY_FILLED/etc.     => PENDING (order may still fill; keep reserved).
 *   - TERMINAL + filled == 0         => TERMINAL_NO_FILL (release reservation).
 *   - TERMINAL + filled > 0          => SETTLABLE, but only if filled <= proposed,
 *                                        avg price > 0, fee >= 0.
 *   - TERMINAL + filled unknown      => PENDING (must be confirmed via exchange read).
 *   - filled > proposed              => INVALID (impossible fill).
 *   - avg price <= 0 (when filled>0) => INVALID.
 *   - fee < 0                        => INVALID.
 *   - non-numeric orderId            => INVALID when provided (NDAX OrderId is numeric).
 */
export function validateEvidenceStructural(intent: ManualTradeIntent, evidence: ManualEvidence): StructuralValidation {
  if (evidence.status === null || evidence.status === 'UNKNOWN') {
    return { ok: true, disposition: 'PENDING', reason: 'no authoritative status reported; awaiting terminal state' };
  }
  if (evidence.orderId !== null && evidence.orderId !== '' && !/^\d+$/.test(evidence.orderId)) {
    return { ok: false, disposition: 'INVALID', reason: `orderId "${evidence.orderId}" is not a numeric NDAX OrderId` };
  }
  const fee = evidence.fee ?? Money.zero();
  if (fee.isNegative()) {
    return { ok: false, disposition: 'INVALID', reason: 'fee must not be negative' };
  }

  if (isOpenStatus(evidence.status)) {
    return { ok: true, disposition: 'PENDING', reason: 'order is still open/partial; awaiting a terminal state' };
  }

  if (evidence.filledQuantity === null) {
    return { ok: true, disposition: 'PENDING', reason: 'terminal state but no reported fill quantity; confirm via exchange' };
  }

  if (evidence.filledQuantity.isNegative()) {
    return { ok: false, disposition: 'INVALID', reason: 'filled quantity must not be negative' };
  }

  if (evidence.filledQuantity.compareTo(intent.quantity) > 0) {
    return {
      ok: false,
      disposition: 'INVALID',
      reason: `impossible fill: ${evidence.filledQuantity} > proposed ${intent.quantity}`,
    };
  }

  if (isTerminalNoFill(evidence.status, evidence.filledQuantity)) {
    return { ok: true, disposition: 'TERMINAL_NO_FILL' };
  }

  // Terminal with a positive fill.
  if (evidence.averagePrice === null || !evidence.averagePrice.isPositive()) {
    return { ok: false, disposition: 'INVALID', reason: 'a terminal fill requires a positive average price' };
  }
  return { ok: true, disposition: 'SETTLABLE' };
}

/**
 * Detect whether a NEW evidence update conflicts with a PREVIOUS evidence record
 * on the same intent. Progression from non-terminal -> terminal is allowed; a
 * terminal record may never be superseded by a different terminal record, nor
 * revert to a non-terminal/open state.
 */
export function evidenceProgressConflict(
  prev: ManualEvidence,
  next: ManualEvidence,
): string | null {
  const prevTerminal = isTerminalStatus(prev.status);
  const nextTerminal = isTerminalStatus(next.status);
  const prevNoFill = isTerminalNoFill(prev.status, prev.filledQuantity);
  const nextNoFill = isTerminalNoFill(next.status, next.filledQuantity);

  if (!prevTerminal) {
    // Non-terminal -> any progression is an update (partial -> full).
    return null;
  }
  if (prevNoFill) {
    // A confirmed no-fill is final; a DIFFERENT terminal state is a conflict.
    if (!nextNoFill) {
      return `prior evidence confirmed terminal no-fill (${prev.status}); a later ${next.status} with fill is a conflict`;
    }
    return null;
  }
  // prev was a positive terminal fill: must be identical or a strict no-fill is a conflict.
  if (!nextTerminal || nextNoFill) {
    return `prior evidence confirmed a terminal fill (${prev.status}); a later ${next.status ?? 'unknown'}/${nextNoFill ? 'no-fill' : ''} is a conflict`;
  }
  return null;
}

/**
 * CONSISTENCY VALIDATION, NOT PROVENANCE PROOF.
 *
 * An operator-supplied `OrderId` is NEVER proof of ownership. NDAX has no
 * trustworthy documented per-execution identity, its `ClientOrderId` may be
 * non-unique, and it has no field that deterministically links an exchange order
 * back to a RETRAC intent. So a same-symbol/same-side/same-quantity order with a
 * plausible price and a post-proposal timestamp can STILL be an unrelated order.
 *
 * This function therefore performs FAIL-CLOSED **consistency validation**: a
 * passing result means "this order is internally consistent with the intent" —
 * NOT "this order is provably the one the operator meant." It NEVER establishes
 * provenance proof (`provenanceProof` is always `false`). Attribution to a
 * specific operator intent ultimately rests on the operator's own explicit
 * acknowledgement, never on a field match. This distinction is deliberate and
 * must not be weakened to make the happy path look stronger.
 *
 * Consistency factors (all must be authoritative exchange data):
 *   - symbol  == intent.symbol   (required)
 *   - side    == intent.side     (required)
 *   - requested/original quantity == intent.quantity, and fill <= requested
 *   - createdAtMs >= intent.createdAtMs (a pre-proposal order is UNRELATED)
 *   - for a limit intent: exchange type == limit AND exchange limit price ==
 *     intent.limitPrice
 *
 * The order is considered CONSISTENT (ok) only when at least one of those factors
 * is verifiable from authoritative data. If only symbol+side match and no factor
 * can be established (all authoritative fields null/absent), it is NOT even
 * consistent and fails closed. We never fall back to a heuristic (quantity +
 * price + timestamp "sameness") to manufacture consistency.
 */
export interface OrderBinding {
  ok: boolean;
  /** The authoritative factors that established consistency (when ok). */
  basis: string[];
  /**
   * ALWAYS `false`. This binding is consistency validation only; it can NEVER
   * prove that an exchange order belongs to a RETRAC intent.
   */
  provenanceProof: false;
  /** Human-readable reason (present when not ok). */
  reason?: string;
}

export function bindOrderToIntent(intent: ManualTradeIntent, authoritative: Order): OrderBinding {
  const basis: string[] = [];

  // --- Required consistency invariants (an order cannot BE in a different market/side). ---
  if (authoritative.symbol !== intent.symbol) {
    return { ok: false, basis, provenanceProof: false, reason: `exchange order is ${authoritative.symbol}, not ${intent.symbol}` };
  }
  if (authoritative.side !== intent.side) {
    return { ok: false, basis, provenanceProof: false, reason: `exchange order is ${authoritative.side}, expected ${intent.side}` };
  }

  // --- Consistency factor 1: requested/original quantity matches the proposal. ---
  const requested = authoritative.quantity;
  if (requested && requested.isPositive()) {
    if (!requested.equals(intent.quantity)) {
      return {
        ok: false,
        basis,
        provenanceProof: false,
        reason: `exchange requested quantity ${requested} != proposed ${intent.quantity}; inconsistent with the intent`,
      };
    }
    if (authoritative.filledQuantity.compareTo(requested) > 0) {
      return {
        ok: false,
        basis,
        provenanceProof: false,
        reason: `exchange fill ${authoritative.filledQuantity} exceeds its own requested quantity ${requested}; malformed/inconsistent`,
      };
    }
    basis.push('requestedQuantity');
  }

  // --- Consistency factor 2: creation time cannot predate the intent proposal. ---
  const createdMs = authoritative.createdAtMs;
  if (createdMs !== null && createdMs !== undefined && Number.isFinite(createdMs)) {
    const proposalMs = intent.createdAtMs;
    if (proposalMs && createdMs < proposalMs) {
      return {
        ok: false,
        basis,
        provenanceProof: false,
        reason: `exchange order created ${createdMs} before the intent was proposed ${proposalMs}; unrelated (pre-proposal) order`,
      };
    }
    basis.push('creationTime');
  }

  // --- Consistency factor 3: limit-intent spec (type + limit price). ---
  if (intent.type === 'limit' && intent.limitPrice) {
    if (authoritative.type !== 'limit') {
      return {
        ok: false,
        basis,
        provenanceProof: false,
        reason: `intent is a limit order but the exchange order is ${authoritative.type}`,
      };
    }
    if (authoritative.price && authoritative.price.isPositive() && !authoritative.price.equals(intent.limitPrice)) {
      return {
        ok: false,
        basis,
        provenanceProof: false,
        reason: `exchange limit price ${authoritative.price} != intended limit ${intent.limitPrice}`,
      };
    }
    basis.push('limitOrder');
  }

  // --- Any remaining fill that exceeds the proposal is inconsistent. ---
  if (authoritative.filledQuantity.compareTo(intent.quantity) > 0) {
    return {
      ok: false,
      basis,
      provenanceProof: false,
      reason: `authoritative fill ${authoritative.filledQuantity} exceeds proposed ${intent.quantity}`,
    };
  }

  if (basis.length === 0) {
    return {
      ok: false,
      basis,
      provenanceProof: false,
      reason:
        'insufficient authoritative data to establish consistency with the intent (no matching requested quantity, ' +
        'creation time, or limit price); consistency validation fails closed',
    };
  }

  // NOTE: even when ok, this is CHARACTERIZATION/consistency, NOT provenance proof.
  return { ok: true, basis, provenanceProof: false };
}

/**
 * Validate evidence against the exchange's authoritative state.
 *
 * The operator's typed values are a HINT. Authority comes from an
 * `getOrderStatus(symbol, _, orderId)` read. The read and the operator evidence
 * must AGREE on the terminal state, fill quantity, and average price, AND the
 * order must bind to the intent via `bindOrderToIntent`; any disagreement, an
 * unbound/unattributable order, or an unreadable/too-new order fails closed.
 */
export interface ExchangeValidation {
  ok: boolean;
  /** The authoritative order, when a read succeeded and the state was final. */
  authoritative?: Order;
  /** True when the read succeeded but the order is not yet terminal. */
  pending?: boolean;
  /** True when the read succeeded but conflicted with the operator evidence / binding. */
  conflict?: boolean;
  /**
   * The consistency factors that aligned (when ok). Representing consistency
   * validation ONLY — this NEVER proves the order belongs to the intent.
   */
  binding?: string[];
  /** ALWAYS `false`. Consistency validation is not provenance proof. */
  provenanceProof?: false;
  reason?: string;
}

export async function validateEvidenceAgainstExchange(
  adapter: ExchangeAdapter,
  intent: ManualTradeIntent,
  evidence: ManualEvidence,
): Promise<ExchangeValidation> {
  if (!evidence.orderId || evidence.orderId === '') {
    return { ok: false, reason: 'cannot validate without an exchange OrderId' };
  }

  let authoritative: Order;
  try {
    authoritative = await adapter.getOrderStatus(intent.symbol, undefined, evidence.orderId);
  } catch (err) {
    return {
      ok: false,
      reason: `exchange order-status read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isTerminalStatus(authoritative.status)) {
    return { ok: true, pending: true, reason: `exchange order ${evidence.orderId} is not yet terminal (${authoritative.status})` };
  }

  // Operator evidence claims must agree with the authoritative read.
  if (evidence.filledQuantity !== null && !evidence.filledQuantity.equals(authoritative.filledQuantity)) {
    return { ok: false, conflict: true, reason: `operator filled ${evidence.filledQuantity} != exchange ${authoritative.filledQuantity}` };
  }
  if (evidence.averagePrice !== null && authoritative.averagePrice !== null && !evidence.averagePrice.equals(authoritative.averagePrice)) {
    return { ok: false, conflict: true, reason: `operator avg-price ${evidence.averagePrice} != exchange ${authoritative.averagePrice}` };
  }

  // OrderId -> intent: the order must be CONSISTENT with the intent. This is
  // consistency validation, NOT provenance proof (no NDAX field proves the order
  // belongs to the RETRAC intent).
  const binding = bindOrderToIntent(intent, authoritative);
  if (!binding.ok) {
    return { ok: false, conflict: true, reason: binding.reason };
  }

  return { ok: true, authoritative, binding: binding.basis, provenanceProof: binding.provenanceProof };
}
