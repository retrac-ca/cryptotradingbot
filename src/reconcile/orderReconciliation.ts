/**
 * Order reconciliation (Reconciliation V1).
 *
 * Classifies a local order given the exchange's authoritative status, the sum of
 * PROVEN execution quantities, and completeness. `OrderState=FILLED` alone is
 * NOT sufficient to finalize accounting (Decision 1). A terminal no-fill or a
 * FILLED order with proven-complete execution set is CONFIRMED; everything else
 * requiring resolution is AMBIGUOUS/OPERATOR_REQUIRED.
 */

import type { Money } from '../money/Money.js';
import type { OrderStatus } from '../order.js';
import type { Completeness, OrderDisposition } from './reconciliationTypes.js';

export interface OrderClassifyInput {
  localStatus: OrderStatus;
  exchangeStatus: OrderStatus | null;
  exchangeExecutedQuantity: Money | null;
  provenExecuted: Money;
  completeness: Completeness;
}

export function classifyOrder(input: OrderClassifyInput): OrderDisposition {
  const { localStatus, exchangeStatus, provenExecuted, completeness } = input;

  // A locally ABANDONED order is an OPERATOR resolution of a fundamentally
  // ambiguous order (see `bot resolve-created-order`). It is terminal locally and
  // there is no exchange outcome to reconcile: it is NOT a claim that the
  // exchange did or did not have the order. Treat it as resolved (no action),
  // never as an unresolved discrepancy.
  if (localStatus === 'ABANDONED') return 'CONFIRMED';

  if (exchangeStatus === null) {
    // No exchange read => cannot confirm anything.
    if (localStatus === 'UNKNOWN' || localStatus === 'CREATED' || localStatus === 'SUBMITTED') return 'AMBIGUOUS';
    if (localStatus === 'OPEN' || localStatus === 'PARTIALLY_FILLED') return 'AMBIGUOUS';
    // A local terminal status with no exchange confirmation is unverified.
    return 'AMBIGUOUS';
  }

  // Terminal no-fill (canceled/rejected/expired with zero proven executed).
  if (exchangeStatus === 'CANCELED' || exchangeStatus === 'REJECTED' || exchangeStatus === 'EXPIRED') {
    if (provenExecuted.isZero()) return 'CONFIRMED';
    return 'AMBIGUOUS'; // terminal but a fill was proven => contradiction
  }

  if (exchangeStatus === 'FILLED') {
    if (completeness === 'COMPLETE') return 'CONFIRMED';
    // FILLED with UNKNOWN/INCOMPLETE completeness => cannot finalize accounting.
    return 'OPERATOR_REQUIRED';
  }

  if (exchangeStatus === 'PARTIALLY_FILLED') {
    if (completeness === 'COMPLETE') return 'PARTIALLY_CONFIRMED';
    return 'AMBIGUOUS';
  }

  if (exchangeStatus === 'OPEN') {
    if (provenExecuted.isZero()) return 'CONFIRMED'; // open, no fill yet
    return 'AMBIGUOUS';
  }

  return 'AMBIGUOUS';
}

/** True when the exchange status is a terminal no-fill. */
export function isTerminalNoFill(exchangeStatus: OrderStatus | null, provenExecuted: Money): boolean {
  if (exchangeStatus !== 'CANCELED' && exchangeStatus !== 'REJECTED' && exchangeStatus !== 'EXPIRED') return false;
  return provenExecuted.isZero();
}
