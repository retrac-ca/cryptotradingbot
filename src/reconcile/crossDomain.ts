/**
 * Cross-domain consistency validation (Reconciliation V1).
 *
 * Persistence does NOT provide cross-file atomicity, so reconciliation validates
 * the relationships between the portfolio, order ledger, reservations, manual
 * intents and settlements. It never repairs ambiguity by deleting or inventing
 * records — it flags the inconsistency (unresolved).
 */

import { isAccountedStatus } from '../manual/types.js';
import type { Order } from '../order.js';
import type { Portfolio } from '../portfolio/Portfolio.js';
import type { ManualTradeIntent } from '../manual/types.js';
import type { ManualSettlement } from '../portfolio/types.js';

export interface CrossDomainResult {
  unresolved: string[];
  reasons: string[];
}

export function crossDomainValidation(
  orders: Map<string, Order>,
  portfolio: Portfolio | null,
  manualIntents: Map<string, ManualTradeIntent>,
  manualSettlements: Map<string, ManualSettlement>,
): CrossDomainResult {
  const unresolved: string[] = [];
  const reasons: string[] = [];

  const orderIds = new Set(orders.keys());

  if (portfolio) {
    // 1) Reservation without a known owner (order ledger or manual intent).
    for (const [reservationId] of portfolio.orderReservationsView()) {
      const hasOrder = orderIds.has(reservationId);
      const hasManualIntent = manualIntents.has(reservationId);
      if (!hasOrder && !hasManualIntent) {
        unresolved.push(reservationId);
        reasons.push(`reservation ${reservationId} has no owning order/intent (orphan) — never release`);
      }
    }

    // 2) A BUY order (non-terminal) that requires a reservation but has none.
    const active = new Set(
      [...portfolio.orderReservationsView().entries()]
        .filter(([, r]) => r.status === 'ACTIVE')
        .map(([id]) => id),
    );
    for (const [clientOrderId, o] of orders) {
      if (o.side === 'BUY' && !isTerminalOrder(o.status) && o.exchangeOrderId && !active.has(clientOrderId)) {
        unresolved.push(clientOrderId);
        reasons.push(`BUY order ${clientOrderId} requires an active reservation but none exists (fail closed)`);
      }
    }
  }

  // 3) A manual ACCOUNTED intent must have a recorded settlement.
  for (const intent of manualIntents.values()) {
    if (isAccountedStatus(intent.status) && !manualSettlements.has(intent.intentId)) {
      unresolved.push(intent.intentId);
      reasons.push(`manual intent ${intent.intentId} is ACCOUNTED but has no portfolio settlement evidence`);
    }
  }

  return { unresolved, reasons };
}

function isTerminalOrder(status: string): boolean {
  return status === 'FILLED' || status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED' || status === 'ABANDONED';
}
