/**
 * Fee disposition (Reconciliation V1).
 *
 * A fee is automatic-accounting-eligible ONLY when it is zero (currency
 * agnostic) OR authoritatively resolved as QUOTE. A base fee, an unresolved
 * feeProductId, a third-asset fee, or a malformed fee all FAIL CLOSED. Fees are
 * never converted (no guessed price).
 */

import { Money } from '../money/Money.js';
import type { MarketInfo } from '../types.js';
import type { FeeDisposition } from './reconciliationTypes.js';

/**
 * Resolve a fee's disposition for accounting.
 *
 * @param fee          the raw fee amount.
 * @param feeProductId the exchange fee-asset product id (verbatim), if any.
 * @param market       the instrument market metadata (base/quote product ids).
 */
export function resolveFeeDisposition(fee: Money, feeProductId: string | null, market: MarketInfo | null): FeeDisposition {
  if (fee.isNegative()) return 'MALFORMED';
  if (fee.isZero()) return 'QUOTE'; // a zero fee is currency-agnostic and safe
  if (!market) return 'UNKNOWN';
  if (!feeProductId || feeProductId === '') return 'UNKNOWN';
  if (market.quoteProductId !== undefined && feeProductId === market.quoteProductId) return 'QUOTE';
  if (market.baseProductId !== undefined && feeProductId === market.baseProductId) return 'BASE';
  return 'UNKNOWN';
}

/** True when the fee disposition permits automatic accounting. */
export function isFeeAutomatable(disposition: FeeDisposition): boolean {
  return disposition === 'QUOTE';
}
