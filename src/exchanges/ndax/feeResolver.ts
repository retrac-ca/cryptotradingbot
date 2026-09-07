/**
 * Authoritative fee-asset resolution (NDAX `feeProductId` → currency).
 *
 * The chain is:
 *   trade.feeProductId → product.id → product.symbol → instrument base/quote
 *
 * We NEVER infer base/quote from a symbol-string convention (e.g. "BTC-CAD").
 * We prefer the EXCHANGE's explicit product metadata:
 *   - `feeProductId === market.baseProductId`   => 'base'
 *   - `feeProductId === market.quoteProductId`  => 'quote'
 *   - otherwise, if the product catalog knows the asset => 'other' (currency
 *     UNKNOWN — a fee in a third asset is NOT quote and cannot be silently
 *     converted); if the product is not in the catalog or the catalog is absent
 *     => 'unknown' (fail closed).
 *
 * Only 'base'/'quote' yield a KNOWN currency. 'other'/'unknown' yield
 * `currency: 'unknown'` and MUST fail closed for authoritative accounting.
 */

import type { AssetProduct, MarketInfo } from '../../types.js';
import type { FeeCurrency } from '../../order.js';

export type FeeAssetKind = 'base' | 'quote' | 'other' | 'unknown';

export interface FeeAssetResolution {
  /** 'base' | 'quote' when the fee asset is resolved to the instrument's base/quote. */
  kind: FeeAssetKind;
  /**
   * The authoritative fee currency: 'base' or 'quote' ONLY when resolved;
   * otherwise 'unknown' (fail closed — never assume 'quote').
   */
  currency: FeeCurrency;
  /** Resolved asset symbol (e.g. "BTC", "CAD", or a third asset), if known. */
  assetSymbol: string | null;
  /** The raw product id we resolved (verbatim, for audit). */
  feeProductId: string | null;
  /** Human-readable reason when the resolution did not yield base/quote. */
  reason?: string;
}

export interface FeeResolverInput {
  /** The market/instrument whose base & quote product ids/symbols define the outcome. */
  market: MarketInfo;
  /** Product catalog (NDAX GetProducts). Null/absent => third/unknown assets cannot be identified. */
  products: AssetProduct[] | null;
}

/**
 * Resolve a raw NDAX `feeProductId` to a fee currency using authoritative
 * product/instrument metadata. Fails closed: unknown/missing/other => 'unknown'.
 */
export function resolveFeeProduct(feeProductId: string | null | undefined, input: FeeResolverInput): FeeAssetResolution {
  if (feeProductId === null || feeProductId === undefined || feeProductId === '') {
    return { kind: 'unknown', currency: 'unknown', assetSymbol: null, feeProductId: null, reason: 'missing feeProductId' };
  }
  const { market, products } = input;

  const baseId = market.baseProductId;
  const quoteId = market.quoteProductId;

  if (baseId !== undefined && feeProductId === baseId) {
    return { kind: 'base', currency: 'base', assetSymbol: market.baseProductSymbol ?? null, feeProductId };
  }
  if (quoteId !== undefined && feeProductId === quoteId) {
    return { kind: 'quote', currency: 'quote', assetSymbol: market.quoteProductSymbol ?? null, feeProductId };
  }

  // To assert a fee asset is a THIRD asset (not base/quote) we must KNOW both the
  // base and the quote product ids. If either is missing we cannot establish the
  // relationship at all, so ANY non-matching feeProductId fails closed (unknown) —
  // it might be the missing base/quote.
  const baseQuoteKnown = baseId !== undefined && quoteId !== undefined;
  if (!baseQuoteKnown) {
    return {
      kind: 'unknown',
      currency: 'unknown',
      assetSymbol: null,
      feeProductId,
      reason: 'instrument base/quote product ids are not both known; cannot classify the fee asset (fail closed)',
    };
  }

  // It is neither the base nor the quote of this instrument.
  if (products) {
    const product = products.find((p) => p.productId === feeProductId);
    if (product) {
      return {
        kind: 'other',
        currency: 'unknown',
        assetSymbol: product.symbol,
        feeProductId,
        reason: `fee is charged in a third asset (${product.symbol}), not the instrument base/quote`,
      };
    }
  }
  return {
    kind: 'unknown',
    currency: 'unknown',
    assetSymbol: null,
    feeProductId,
    reason: 'feeProductId is neither the instrument base nor quote and could not be resolved to a known product',
  };
}
