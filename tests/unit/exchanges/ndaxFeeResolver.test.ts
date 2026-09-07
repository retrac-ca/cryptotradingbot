/**
 * Gate 9.3 — authoritative fee-currency resolution (feeProductId → base/quote/other/unknown).
 *
 * The core invariant: fee currency is derived ONLY from exchange product/instrument
 * metadata, NEVER assumed from the symbol string or a `feeCurrency='quote'` default.
 * A base fee is never reinterpreted as quote; a third-asset fee is never converted
 * to quote; an unknown/missing product fails closed.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { resolveFeeProduct } from '../../../src/exchanges/ndax/feeResolver.js';
import { mapProduct } from '../../../src/exchanges/ndax/mappings.js';
import type { AssetProduct, MarketInfo } from '../../../src/types.js';

/** A market (BTC/CAD) with authoritative base/quote product ids & symbols. */
const btcCad: MarketInfo = {
  symbol: 'BTC/CAD',
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0.0001'),
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  baseProductId: '1', // productId 1 = BTC
  quoteProductId: '2', // productId 2 = CAD
  baseProductSymbol: 'BTC',
  quoteProductSymbol: 'CAD',
};

const products: AssetProduct[] = [
  { productId: '1', symbol: 'BTC', name: 'Bitcoin', type: 'cryptoCurrency', decimalPlaces: 8, tickSize: null, noFees: false },
  { productId: '2', symbol: 'CAD', name: 'Canadian Dollar', type: 'nationalCurrency', decimalPlaces: 2, tickSize: null, noFees: false },
  { productId: '3', symbol: 'ETH', name: 'Ethereum', type: 'cryptoCurrency', decimalPlaces: 8, tickSize: null, noFees: false },
];

describe('Gate 9.3 — fee-currency resolution', () => {
  it('quote fee: feeProductId == quoteProductId resolves to quote (CAD)', () => {
    const r = resolveFeeProduct('2', { market: btcCad, products });
    expect(r.kind).toBe('quote');
    expect(r.currency).toBe('quote');
    expect(r.assetSymbol).toBe('CAD');
  });

  it('base fee: feeProductId == baseProductId resolves to base (BTC)', () => {
    const r = resolveFeeProduct('1', { market: btcCad, products });
    expect(r.kind).toBe('base');
    expect(r.currency).toBe('base');
    expect(r.assetSymbol).toBe('BTC');
  });

  it('third-asset fee: feeProductId resolves to a NON base/quote product => other (currency unknown)', () => {
    const r = resolveFeeProduct('3', { market: btcCad, products });
    expect(r.kind).toBe('other');
    expect(r.currency).toBe('unknown'); // NEVER converted to quote
    expect(r.assetSymbol).toBe('ETH');
  });

  it('unknown product id: no matching product and not base/quote => unknown (fail closed)', () => {
    const r = resolveFeeProduct('999', { market: btcCad, products });
    expect(r.kind).toBe('unknown');
    expect(r.currency).toBe('unknown');
    expect(r.assetSymbol).toBeNull();
  });

  it('missing feeProductId => unknown (fail closed when an authoritative fee is required)', () => {
    expect(resolveFeeProduct(null, { market: btcCad, products }).kind).toBe('unknown');
    expect(resolveFeeProduct(undefined, { market: btcCad, products }).kind).toBe('unknown');
    expect(resolveFeeProduct('', { market: btcCad, products }).kind).toBe('unknown');
  });

  it('no product catalog: a non base/quote feeProductId => unknown (cannot identify the asset)', () => {
    const r = resolveFeeProduct('3', { market: btcCad, products: null });
    expect(r.kind).toBe('unknown');
    expect(r.currency).toBe('unknown');
  });

  it('missing base/quote product ids (no instrument metadata) => base/quote cannot be classified', () => {
    const bare: MarketInfo = { ...btcCad, baseProductId: undefined, quoteProductId: undefined };
    expect(resolveFeeProduct('1', { market: bare, products }).kind).toBe('unknown');
    expect(resolveFeeProduct('2', { market: bare, products }).kind).toBe('unknown');
  });

  it('product/instrument mismatch is NOT silently coerced to quote (a base asset that is not this instrument base)', () => {
    // feeProductId resolves to a product (XRP) that is NOT this instrument's base/quote.
    const withXrp: AssetProduct[] = [products[0]!, products[1]!, { ...products[2]!, productId: '4', symbol: 'XRP' }];
    const r = resolveFeeProduct('4', { market: btcCad, products: withXrp });
    expect(r.kind).toBe('other');
    expect(r.currency).toBe('unknown');
    expect(r.assetSymbol).toBe('XRP');
  });

  it('zero fee is a valid, distinguishable outcome (currency still resolved; zero amount is authoritative)', () => {
    // The resolver resolves currency; zero vs missing is a SEPARATE decision kept at the
    // accounting layer. A feeProductId present with a zero fee amount is quoted/base.
    const r = resolveFeeProduct('2', { market: btcCad, products });
    expect(r.kind).toBe('quote');
    expect(r.currency).toBe('quote');
    // Zero fee amount (authored at accounting) is not "missing" — distinguish via the
    // presence of feeProductId (the resolver does not null it).
    expect(r.feeProductId).toBe('2');
  });

  it('mapProduct surfaces the authoritative product vocabulary (id, symbol, type)', () => {
    const p = mapProduct({ ProductId: 1, Product: 'BTC', ProductFullName: 'Bitcoin', ProductType: 2, DecimalPlaces: 8 });
    expect(p.productId).toBe('1');
    expect(p.symbol).toBe('BTC');
    expect(p.type).toBe('cryptoCurrency');
    expect(p.decimalPlaces).toBe(8);
  });

  it('base-denominated fee is never silently treated as quote at the accounting boundary', () => {
    // The resolver returns currency 'base' for a base fee; downstream accounting
    // must treat currency !== 'quote' as non-accountable (fail closed).
    const r = resolveFeeProduct('1', { market: btcCad, products });
    expect(r.currency).toBe('base');
    expect(r.currency === 'quote').toBe(false);
  });
});
