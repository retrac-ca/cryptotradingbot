import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { buildUniverse, eligibleSymbols, UNIVERSE_REASON } from '../../../src/engine/universe.js';
import type { MarketInfo } from '../../../src/types.js';

function mk(symbol: string, over: Partial<MarketInfo> = {}): MarketInfo {
  return {
    symbol,
    exchangeId: '1',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 2,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.0001'),
    minOrderQuote: null,
    supportsMarketOrders: true,
    feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
    ...over,
  };
}

const approved = ['BTC/CAD', 'ETH/CAD', 'SOL/CAD'];
const filter = { quote: 'CAD', approvedSymbols: approved };

describe('Market universe & eligibility', () => {
  it('includes configured approved markets', () => {
    const markets = [mk('BTC/CAD'), mk('ETH/CAD'), mk('SOL/CAD')];
    const out = buildUniverse(markets, filter);
    expect(eligibleSymbols(markets, filter).sort()).toEqual(['BTC/CAD', 'ETH/CAD', 'SOL/CAD']);
    for (const e of out) if (e.eligible) expect(e.reason).toBe(UNIVERSE_REASON.ELIGIBLE);
  });

  it('does not include non-CAD markets', () => {
    const markets = [mk('BTC/CAD'), mk('ETH/USDT')];
    const out = buildUniverse(markets, { quote: 'CAD', approvedSymbols: ['BTC/CAD', 'ETH/USDT'] });
    const eth = out.find((e) => e.symbol === 'ETH/USDT');
    expect(eth).toBeDefined();
    expect(eth!.eligible).toBe(false);
    expect(eth!.reason).toBe(UNIVERSE_REASON.UNSUPPORTED_QUOTE);
  });

  it('excludes a supported market not in the approval whitelist', () => {
    const markets = [mk('BTC/CAD'), mk('PEPE/CAD')];
    const out = buildUniverse(markets, filter);
    expect(out.find((e) => e.symbol === 'PEPE/CAD')).toBeUndefined();
  });

  it('excludes markets with invalid ticks (zero/negative)', () => {
    const markets = [mk('BTC/CAD', { priceTick: Money.zero() }), mk('ETH/CAD', { quantityTick: Money.zero() })];
    const f = { quote: 'CAD', approvedSymbols: ['BTC/CAD', 'ETH/CAD'] };
    const out = buildUniverse(markets, f);
    expect(eligibleSymbols(markets, f)).toEqual([]);
    expect(out.every((e) => !e.eligible)).toBe(true);
    expect(out.map((e) => e.reason)).toEqual([UNIVERSE_REASON.INVALID_TICK, UNIVERSE_REASON.INVALID_TICK]);
  });

  it('excludes markets without a minimum order size', () => {
    const markets = [mk('BTC/CAD', { minOrderBase: null, minOrderQuote: null })];
    const out = buildUniverse(markets, filter);
    expect(out[0]!.eligible).toBe(false);
    expect(out[0]!.reason).toBe(UNIVERSE_REASON.NO_MIN_ORDER);
  });

  it('excludes markets that do not support market orders', () => {
    const markets = [mk('BTC/CAD', { supportsMarketOrders: false })];
    expect(buildUniverse(markets, filter)[0]!.reason).toBe(UNIVERSE_REASON.NO_MARKET_ORDERS);
  });

  it('excludes markets with unknown fees', () => {
    const markets = [mk('BTC/CAD', { feeInfo: null })];
    expect(buildUniverse(markets, filter)[0]!.reason).toBe(UNIVERSE_REASON.UNKNOWN_FEES);
  });

  it('does not require unreliable bid/ask order-count fields (eligibility is structural)', () => {
    const markets = [mk('BTC/CAD', { /* only metadata, no order counts */ })];
    expect(eligibleSymbols(markets, filter)).toEqual(['BTC/CAD']);
  });

  it('excludes a requested symbol not present in discovered markets (+/- unknown)', () => {
    const markets = [mk('BTC/CAD')];
    const out = buildUniverse(markets, { quote: 'CAD', approvedSymbols: ['BTC/CAD', 'NOPE/CAD'] });
    const nope = out.find((e) => e.symbol === 'NOPE/CAD')!;
    expect(nope.eligible).toBe(false);
    expect(nope.reason).toBe(UNIVERSE_REASON.UNSUPPORTED_MARKET);
    expect(nope.marketInfo).toBeNull();
  });

  it('is deterministic regardless of input market order', () => {
    const m = [mk('ETH/CAD'), mk('BTC/CAD')];
    expect(eligibleSymbols(m, filter)).toEqual(['BTC/CAD', 'ETH/CAD']);
  });
});
