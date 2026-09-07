/**
 * Execution correlation (Reconciliation V1).
 *
 * Correlates an exchange `AccountTrade` record to a local order. PROVEN requires
 * ALL of: non-empty executionId, non-empty exchange OrderId, exact normalized
 * OrderId match (`sameExternalOrderId`), symbol match, side match, and
 * structurally-valid quantity/price/fee. Nothing weaker is PROVEN.
 *
 * `ClientOrderId` is NEVER a PROVEN correlation key for NDAX (not unique).
 */

import { Portfolio } from '../portfolio/Portfolio.js';
import type { AccountTrade } from '../types.js';
import type { Order } from '../order.js';
import type { CorrelationLevel } from './reconciliationTypes.js';

export interface CorrelationResult {
  correlation: CorrelationLevel;
  /** The local clientOrderId this execution is PROVEN to belong to, if any. */
  matchedClientOrderId: string | null;
  reason: string;
}

/**
 * Correlate one exchange execution to the local order ledger.
 *
 * Only identity (normalized exchangeOrderId) + symbol + side + structural
 * validity establish PROVEN belonging. Symbol/quantity/price/timestamp similarity
 * and clientOrderId are NEVER used as PROVEN evidence.
 */
export function correlateExecution(trade: AccountTrade, orders: Map<string, Order>): CorrelationResult {
  if (!trade.executionId) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution has no executionId; cannot be PROVEN or accounted' };
  }
  if (!trade.orderId) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution has no exchange OrderId; cannot be PROVEN or accounted' };
  }
  if (!trade.symbol) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution has no resolvable symbol' };
  }
  if (!trade.quantity.isPositive()) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution quantity is not positive' };
  }
  if (!trade.price.isPositive()) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution price is not positive' };
  }
  if (trade.fee.isNegative()) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: 'execution fee is negative' };
  }

  const matches: string[] = [];
  for (const [clientOrderId, o] of orders) {
    if (!o.exchangeOrderId) continue;
    // Exact normalized exchange OrderId match (never a string-format mismatch).
    if (!Portfolio.sameExternalOrderId(o.exchangeOrderId, trade.orderId)) continue;
    if (o.symbol !== trade.symbol) continue;
    if (o.side !== trade.side) continue;
    matches.push(clientOrderId);
  }

  if (matches.length === 0) {
    return { correlation: 'UNCORRELATED', matchedClientOrderId: null, reason: 'no local order shares this exchange OrderId (symbol/side/OrderId)' };
  }
  if (matches.length > 1) {
    return { correlation: 'AMBIGUOUS', matchedClientOrderId: null, reason: `multiple local orders match this OrderId (${matches.join(', ')}); ambiguous` };
  }
  return { correlation: 'PROVEN', matchedClientOrderId: matches[0]!, reason: 'PROVEN: exact OrderId + symbol + side + valid execution data' };
}
