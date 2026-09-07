/**
 * Execution-set completeness (Reconciliation V1).
 *
 * NDAX `GetAccountTrades` is paginated, has no order filter, and its ordering is
 * undocumented — so a given order's FULL execution set is NOT provably
 * enumerable. Equality between the exchange-reported executed quantity and the
 * sum of PROVEN executions is therefore NOT, by itself, proof of completeness.
 *
 * Outcomes:
 *   - COMPLETE   : the order has no fill (nothing to enumerate) — finalizable.
 *   - INCOMPLETE : PROVEN executions are strictly less (or more) than the
 *                  exchange-reported executed quantity — a definite gap/conflict.
 *   - UNKNOWN    : can't prove enumeration (the common NDAX case) — NOT finalizable.
 */

import { Money } from '../money/Money.js';
import type { Completeness } from './reconciliationTypes.js';

export function analyzeCompleteness(exchangeExecutedQuantity: Money | null, provenExecuted: Money): Completeness {
  if (exchangeExecutedQuantity === null || exchangeExecutedQuantity === undefined) {
    return 'UNKNOWN';
  }
  if (!exchangeExecutedQuantity.isPositive()) {
    // The exchange reports a non-positive executed quantity. If executions are
    // PROVEN, this is a contradiction and must NEVER be treated as complete: a
    // filled order is not "completely enumerated" just because the exchange
    // reported a zero/negative quantity. Only a genuinely no-fill order (no
    // PROVEN executions) is complete.
    if (provenExecuted.isZero()) {
      return 'COMPLETE';
    }
    // PROVEN exceeds the reported executed quantity => a definite conflict.
    return 'INCOMPLETE';
  }
  const cmp = provenExecuted.compareTo(exchangeExecutedQuantity);
  if (cmp > 0) return 'INCOMPLETE'; // PROVEN exceeds reported executed (contradiction)
  if (cmp < 0) return 'INCOMPLETE'; // definite gap: some executions not accounted
  // Quantity matches, but enumeration is NOT provable for NDAX.
  return 'UNKNOWN';
}
