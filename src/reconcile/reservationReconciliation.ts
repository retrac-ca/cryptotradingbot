/**
 * Reservation reconciliation (Reconciliation V1).
 *
 * A reservation is released ONLY when the existing safety rules PROVE release is
 * safe (confirmed terminal no-fill, or a FILLED order whose execution set is
 * complete). Every other case — UNKNOWN, OPEN, PARTIALLY_FILLED, FILLED-with-
 * incomplete-accounting, missing owner, uncertain execution — RETAINS the
 * reservation.
 */

import type { Money } from '../money/Money.js';
import type { OrderStatus } from '../order.js';
import type { ReservationDisposition } from './reconciliationTypes.js';
import { isTerminalNoFill } from './orderReconciliation.js';

export interface ReservationDecisionInput {
  /** The reservation exists (has an owner). */
  hasReservation: boolean;
  exchangeStatus: OrderStatus | null;
  provenExecuted: Money;
  /** True only when a FILLED order's execution set is complete. */
  accountingComplete: boolean;
}

export function reservationDisposition(input: ReservationDecisionInput): ReservationDisposition {
  if (!input.hasReservation) {
    // No reservation to reason about (cross-domain may flag a required-missing one).
    return 'RETAIN';
  }
  // Confirmed terminal no-fill => release exactly once.
  if (isTerminalNoFill(input.exchangeStatus, input.provenExecuted)) {
    return 'RELEASE';
  }
  // Confirmed FILLED with complete accounting => release (all cost accounted).
  if (input.exchangeStatus === 'FILLED' && input.accountingComplete) {
    return 'RELEASE';
  }
  // Everything else (UNKNOWN, OPEN, PARTIALLY_FILLED, FILLED-incomplete, missing
  // owner, uncertain execution) => RETAIN.
  return 'RETAIN';
}
