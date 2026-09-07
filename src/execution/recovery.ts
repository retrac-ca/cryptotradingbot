/**
 * Ambiguous-submission recovery classifier (Gate 7.3).
 *
 * After a submission whose outcome is unknown (timeout, connection reset,
 * malformed ack, lost response), the local system holds a logical order whose
 * `exchangeOrderId` is null and whose status is `UNKNOWN`. Recovery must answer
 * ONE question: can the exchange's current state UNIQUELY identify that original
 * logical order? If yes, we may attach the exchange order id and refresh
 * authoritative state. If not, the order must REMAIN UNKNOWN — it is never
 * rejected, never assumed filled, and never re-submitted.
 *
 * This module is exchange-agnostic. It matches ONLY on provably-unique, shared
 * identities and NEVER on heuristics (symbol/quantity/price/timestamp/array
 * position/"most recent"). A no-match is NOT authoritative proof of rejection.
 *
 * Identity rules:
 *   - `exchangeOrderId` is the only identity an exchange (NDAX: "Order ID unique
 *     across an OMS") provably guarantees to be unique. A local order WITH a
 *     known exchangeOrderId can be matched uniquely by it.
 *   - A client order id (e.g. NDAX `ClientOrderId`, a LONG INTEGER "which may
 *     not be unique") is only trusted as a UNIQUE match when the exchange
 *     contract explicitly guarantees uniqueness (`clientOrderIdIsUnique`).
 *     NDAX does NOT, so for NDAX client-order-id re-attachment stays disabled.
 */

import type { Order } from '../order.js';

export type ReattachmentOutcome =
  | 'UNIQUE_MATCH' // exactly one provably-unique order found
  | 'ZERO_MATCH' // no provably-unique order found (NOT proof of rejection)
  | 'MULTIPLE_MATCH' // >1 provable matches -> ambiguous, fail closed
  | 'MALFORMED'; // inputs not well-formed -> fail closed

export interface ReattachmentResult {
  outcome: ReattachmentOutcome;
  /** The single matched exchange order on `UNIQUE_MATCH`. */
  order?: Order;
  /** Human-readable cause (for logs / operator). */
  message: string;
}

export interface ReattachmentPolicy {
  /**
   * True only when the exchange contract provably guarantees the client order
   * id is a UNIQUE logical-order identifier. NDAX documents `ClientOrderId` as
   * a LONG INTEGER and "(may not be unique)", so this is FALSE for NDAX — a
   * matching client order id is never treated as a unique match, and recovery
   * remains UNKNOWN.
   */
  clientOrderIdIsUnique?: boolean;
}

/**
 * True iff `candidate` PROVABLY matches the same logical exchange order as
 * `local`, using only an exact, trustworthy identity. This deliberately encodes
 * the no-heuristic rule: a candidate that merely shares symbol/quantity/price/
 * timestamp is NOT a match.
 */
export function isProvableReattachmentMatch(local: Order, candidate: Order, policy: ReattachmentPolicy = {}): boolean {
  if (!local || !candidate) return false;
  // An exchange order id is unique and, when both sides carry the same non-empty
  // value, is a proof of identity.
  if (local.exchangeOrderId && candidate.exchangeOrderId && candidate.exchangeOrderId === local.exchangeOrderId) {
    // Same market guard (an order cannot be in two symbols).
    return candidate.symbol === local.symbol;
  }
  // A client order id is a legitimate identity ONLY when the exchange contract
  // guarantees uniqueness. Otherwise it is not proof (NDAX: "(may not be unique)").
  if (policy.clientOrderIdIsUnique) {
    return (
      candidate.clientOrderId !== '' &&
      candidate.symbol === local.symbol &&
      candidate.clientOrderId === local.clientOrderId
    );
  }
  return false;
}

/**
 * Classify how to re-attach an ambiguous local order against the set of
 * exchange candidate orders (e.g. from `getOpenOrders` + `getOrderHistory`).
 *
 * Outcomes:
 *   - UNIQUE_MATCH: exactly one provable match (attach its exchangeOrderId).
 *   - ZERO_MATCH:   no provable match. Recovery must remain UNKNOWN (a zero
 *                   match is NOT authoritative proof the order was rejected —
 *                   the exchange may not have returned it, or may not retain it).
 *   - MULTIPLE_MATCH: >1 provable matches. Ambiguous; fail closed; NEVER choose
 *                   one heuristically.
 *   - MALFORMED:    invalid inputs. Fail closed.
 */
export function classifyReattachment(local: Order, candidates: Order[], policy: ReattachmentPolicy = {}): ReattachmentResult {
  if (!local || !Array.isArray(candidates)) {
    return { outcome: 'MALFORMED', message: 'classifyReattachment: missing local order or candidate list' };
  }
  const provable = candidates.filter((c) => isProvableReattachmentMatch(local, c, policy));
  if (provable.length === 1) {
    return { outcome: 'UNIQUE_MATCH', order: provable[0]!, message: 'unique provable identity match found' };
  }
  if (provable.length > 1) {
    return {
      outcome: 'MULTIPLE_MATCH',
      message: `multiple provable matches (${provable.length}); cannot resolve without ambiguity`,
    };
  }
  return {
    outcome: 'ZERO_MATCH',
    message: 'no provable unique identity match; order must remain UNKNOWN (zero match is not proof of rejection)',
  };
}
