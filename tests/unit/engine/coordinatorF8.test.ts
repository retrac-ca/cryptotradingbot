/**
 * F-8 — price/freshness source hardening in the MarketCoordinator.
 *
 * The core F-8 change: a NON-candidate managed position is only valued for
 * portfolio equity/exposure when its cached quote is FRESH. A stale or missing
 * managed-position price makes the risk context fail closed (portfolioValue /
 * portfolioExposure = null), so a stale/low managed price can never under-state
 * exposure and let an oversized BUY through.
 *
 * Also proves market isolation (each symbol valued by its OWN ticker/clocked
 * quote), and that a stale CANDIDATE quote cannot win ranking because the
 * RiskManager fails closed on it.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { FreshnessPolicy } from '../../../src/marketdata/freshness.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';
import { signal } from '../../../src/strategy/Signal.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../../src/types.js';

const TW: Timeframe = '5m';
const NOW = 1_000_000;
const MAX_AGE = 60_000;

const riskConfig: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.5,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 10,
  marketDataMaxAgeMs: MAX_AGE,
  marketDataTransportMaxAgeMs: MAX_AGE,
  maxClockSkewMs: 120_000,
};

const freshnessPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: MAX_AGE,
  maxTransportAgeMs: MAX_AGE,
  maxAcceptableFutureSkewMs: 120_000,
};

function market(symbol: string): MarketInfo {
  return {
    symbol, exchangeId: '1', priceTick: Money.fromString('0.01'),
    basePrecision: 2, quotePrecision: 2, quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.000001'), minOrderQuote: null,
    supportsMarketOrders: true, feeInfo: { maker: 0.0005, taker: 0.0005, feeCurrency: 'quote' },
  };
}

/** Build a ticker with explicit quote/observed timestamps so staleness is testable. */
function ticker(symbol: string, price: string, timestampMs: number): Ticker {
  const p = Money.fromString(price);
  return { symbol, bid: p, ask: p, last: p, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs, observedAtMs: timestampMs };
}

class StubStrategy implements Strategy {
  readonly id = 'stub';
  readonly name = 'stub';
  readonly timeframe: Timeframe = TW;
  readonly warmupCandles = 1;
  private grid: Map<string, 'BUY' | 'SELL' | 'HOLD'>;
  constructor(grid: Record<string, 'BUY' | 'SELL' | 'HOLD'>) {
    this.grid = new Map(Object.entries(grid));
  }
  evaluate(ctx: StrategyContext): Signal {
    const t = this.grid.get(ctx.symbol) ?? 'HOLD';
    return signal(ctx.symbol, t, t === 'HOLD' ? { reason: 'hold' } : { reason: 'genuine' }, ctx.nowMs);
  }
  describe(): string {
    return 'stub';
  }
}

interface Harness {
  coordinator: MarketCoordinator;
  risk: RiskManager;
  portfolio: Portfolio;
  source: { infos: Map<string, MarketInfo>; tickers: Map<string, Ticker>; candles: Map<string, Candle[]> };
}

function build(
  opts: { managed?: (p: Portfolio) => Portfolio; signals: Record<string, 'BUY' | 'SELL' | 'HOLD'>; tickers: Record<string, { price: string; ts: number }> },
): Harness {
  const portfolio = opts.managed
    ? opts.managed(Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])))
    : Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
  const risk = new RiskManager(riskConfig);
  const source = { infos: new Map<string, MarketInfo>(), tickers: new Map<string, Ticker>(), candles: new Map<string, Candle[]>() };
  for (const s of Object.keys(opts.tickers)) {
    source.infos.set(s, market(s));
    source.tickers.set(s, ticker(s, opts.tickers[s]!.price, opts.tickers[s]!.ts));
  }
  const coordinator = new MarketCoordinator({
    strategy: new StubStrategy(opts.signals),
    riskManager: risk,
    getPortfolio: () => portfolio,
    timeframe: TW,
    marketSource: {
      getMarketInfo: (s) => source.infos.get(s) ?? null,
      getTicker: (s) => source.tickers.get(s) ?? null,
      getCandles: (s) => source.candles.get(s) ?? [],
    },
    freshnessPolicy,
  });
  return { coordinator, risk, portfolio, source };
}

const FRESH = NOW;
const STALE = NOW - 200_000; // 200s old >> 60s max age

describe('F-8 — managed-position valuation fails closed on stale price', () => {
  it('a STALE managed-position quote makes the whole risk context fail closed (no approved BUY)', () => {
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'ETH/CAD': { price: '3000', ts: STALE }, 'SOL/CAD': { price: '100', ts: FRESH } },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    // The stale ETH valuation makes portfolioValue/exposure unknown -> SOL rejected.
    expect(r.selected).toBeNull();
    const sol = r.evaluated.find((e) => e.symbol === 'SOL/CAD');
    expect(sol?.decision?.approved).toBe(false);
    if (sol?.decision && !sol.decision.approved) {
      expect(['UNKNOWN_PORTFOLIO_VALUE', 'UNKNOWN_EXPOSURE']).toContain(sol.decision.reason);
    }
  });

  it('a MISSING managed-position quote still fails closed (F-2 preserved)', () => {
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'SOL/CAD': { price: '100', ts: FRESH } }, // ETH deliberately missing
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    expect(r.selected).toBeNull();
    const sol = r.evaluated.find((e) => e.symbol === 'SOL/CAD');
    expect(sol?.decision?.approved).toBe(false);
  });

  it('FRESH managed prices restore a valid, correctly-sized BUY', () => {
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'ETH/CAD': { price: '3000', ts: FRESH }, 'SOL/CAD': { price: '100', ts: FRESH } },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      // equity = 800 + 0.1*3000 = 1100; maxExposure = 550; ETH exposure 300; room 250.
      expect(r.selected.estimatedNotional.compareTo(Money.fromString('250.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('a stale NON-candidate price cannot inflate risk capacity (exposure not under-stated)', () => {
    // Even if the stale managed price were LOW (under-stating exposure), we fail
    // closed rather than trusting it.
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'ETH/CAD': { price: '1', ts: STALE }, 'SOL/CAD': { price: '100', ts: FRESH } },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    expect(r.selected).toBeNull();
  });
});

describe('F-8 — market isolation', () => {
  it('each managed market is valued by its OWN ticker price, not another market', () => {
    // BTC 0.005 @ 40000 (cost 200 => cash 800); ETH 0.05 @ 2000 (cost 100 => cash 700).
    const h = build({
      managed: (p) =>
        p
          .applyFill('BTC/CAD', 'BUY', Money.fromString('0.005'), Money.fromString('40000'), Money.zero())
          .applyFill('ETH/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('2000'), Money.zero()),
      signals: { 'XRP/CAD': 'BUY' },
      tickers: { 'BTC/CAD': { price: '40000', ts: FRESH }, 'ETH/CAD': { price: '3000', ts: FRESH }, 'XRP/CAD': { price: '2', ts: FRESH } },
    });
    const r = h.coordinator.evaluate(['XRP/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      // equity=700+200+150=1050; maxExposure=525; exposure=350; room=175.
      expect(r.selected.estimatedNotional.compareTo(Money.fromString('175.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('a stale quote for ONE managed market makes the whole valuation fail closed (no silent zero)', () => {
    // Both BTC and ETH managed; BTC stale, ETH fresh. Failing closed (not valuing
    // BTC at zero) is the only safe outcome.
    const h = build({
      managed: (p) =>
        p
          .applyFill('BTC/CAD', 'BUY', Money.fromString('0.005'), Money.fromString('40000'), Money.zero())
          .applyFill('ETH/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('2000'), Money.zero()),
      signals: { 'XRP/CAD': 'BUY' },
      tickers: { 'BTC/CAD': { price: '40000', ts: STALE }, 'ETH/CAD': { price: '3000', ts: FRESH }, 'XRP/CAD': { price: '2', ts: FRESH } },
    });
    const r = h.coordinator.evaluate(['XRP/CAD'], NOW);
    expect(r.selected).toBeNull();
    const xrp = r.evaluated.find((e) => e.symbol === 'XRP/CAD');
    expect(xrp?.decision?.approved).toBe(false);
  });

  it("the candidate's freshness comes from the candidate's own ticker, not another market", () => {
    // ETH managed but stale; the BTC candidate is evaluated for ITS OWN freshness.
    // The candidate symbol's ticker is fresh; the stale ETH is a NON-candidate, so
    // it fails closed on portfolio valuation (BTC rejected), NOT on candidate freshness.
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('2000'), Money.zero()),
      signals: { 'BTC/CAD': 'BUY' },
      tickers: { 'BTC/CAD': { price: '40000', ts: FRESH }, 'ETH/CAD': { price: '3000', ts: STALE } },
    });
    const r = h.coordinator.evaluate(['BTC/CAD'], NOW);
    const btc = r.evaluated.find((e) => e.symbol === 'BTC/CAD')!;
    expect(btc.decision?.reason).not.toBe('STALE_MARKET_DATA'); // BTC itself is fresh
    expect(btc.decision?.approved).toBe(false); // but portfolio valuation unknown (stale ETH)
  });
});

describe('F-8 — candidate staleness cannot win ranking', () => {
  it('a stale candidate quote is risk-rejected, so it cannot be selected', () => {
    const h = build({
      signals: { 'BTC/CAD': 'BUY' },
      tickers: { 'BTC/CAD': { price: '40000', ts: STALE } },
    });
    const r = h.coordinator.evaluate(['BTC/CAD'], NOW);
    expect(r.selected).toBeNull();
    const btc = r.evaluated.find((e) => e.symbol === 'BTC/CAD')!;
    expect(btc.decision?.approved).toBe(false);
    if (btc.decision && !btc.decision.approved) expect(btc.decision.reason).toBe('STALE_MARKET_DATA');
  });

  it('a fresh candidate with a valid spread is selected (ranking still works on fresh data)', () => {
    const h = build({
      signals: { 'BTC/CAD': 'BUY', 'ETH/CAD': 'BUY' },
      tickers: {
        // BTC tighter spread, both fresh.
        'BTC/CAD': { price: '100', ts: FRESH },
        'ETH/CAD': { price: '3000', ts: FRESH },
      },
    });
    // Give them distinct bid/ask spreads by building a second coordinator map.
    h.source.tickers.set('BTC/CAD', { ...ticker('BTC/CAD', '100', FRESH), ask: Money.fromString('101') });
    h.source.tickers.set('ETH/CAD', { ...ticker('ETH/CAD', '3000', FRESH), ask: Money.fromString('3090') });
    const r = h.coordinator.evaluate(['ETH/CAD', 'BTC/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    expect(r.selected!.symbol).toBe('BTC/CAD'); // tighter relative spread wins
  });
});
