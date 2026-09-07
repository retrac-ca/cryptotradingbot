import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';
import { signal } from '../../../src/strategy/Signal.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { FreshnessPolicy } from '../../../src/marketdata/freshness.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../../src/types.js';

const TW: Timeframe = '5m';
const NOW = 1_000_000;

const riskConfig: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.5,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 10,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

const freshnessPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: riskConfig.marketDataMaxAgeMs,
  maxTransportAgeMs: riskConfig.marketDataTransportMaxAgeMs,
  maxAcceptableFutureSkewMs: riskConfig.maxClockSkewMs,
};

function mInfo(symbol: string): MarketInfo {
  return {
    symbol, exchangeId: '1', priceTick: Money.fromString('0.01'),
    basePrecision: 2, quotePrecision: 2, quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.000001'), minOrderQuote: null,
    supportsMarketOrders: true, feeInfo: { maker: 0.0005, taker: 0.0005, feeCurrency: 'quote' },
  };
}

function tk(symbol: string, price: string): Ticker {
  const p = Money.fromString(price);
  return { symbol, bid: p, ask: p, last: p, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs: NOW, observedAtMs: NOW };
}

/** Strategy stub that yields a fixed, genuine signal per symbol. */
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
  opts: { managed?: (p: Portfolio) => Portfolio; signals: Record<string, 'BUY' | 'SELL' | 'HOLD'>; tickers: Record<string, string> },
): Harness {
  const portfolio = opts.managed
    ? opts.managed(Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])))
    : Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
  const risk = new RiskManager(riskConfig);
  const source = { infos: new Map<string, MarketInfo>(), tickers: new Map<string, Ticker>(), candles: new Map<string, Candle[]>() };
  for (const s of Object.keys(opts.tickers)) {
    source.infos.set(s, mInfo(s));
    source.tickers.set(s, tk(s, opts.tickers[s]!));
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

describe('MarketCoordinator — F-2 portfolio-wide equity/exposure', () => {
  it('TEST A/B: an existing managed position counts toward exposure, capping the candidate BUY', () => {
    // Managed ETH: 0.1 @ 2000 cost (cash 800). ETH price 3000, SOL price 100.
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'ETH/CAD': '3000', 'SOL/CAD': '100' },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    // With full accounting: equity = 800 cash + 0.1*3000 = 1100; maxExposure = 550;
    // existing ETH exposure = 300; room = 250 => SOL notional <= 250 => qty 2.5.
    // (Under the old bug SOL would be sized to ~4.0 / 400 notional.)
    if (r.selected) {
      expect(r.selected.estimatedNotional.compareTo(Money.fromString('250.00'))).toBeLessThanOrEqual(0);
      expect(r.selected.quantity.toFixed(8)).toBe('2.50000000');
      // Combined exposure (ETH 300 + SOL 250) must not exceed 0.5 * equity (550).
      const combined = Money.fromString('300').add(r.selected.estimatedNotional);
      expect(combined.compareTo(Money.fromString('550.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('TEST C: multiple existing managed positions are all counted when valuing a third symbol', () => {
    // BTC 0.005 @ 40000 (cost 200 => cash 800); ETH 0.05 @ 2000 (cost 100 => cash 700).
    const h = build({
      managed: (p) =>
        p
          .applyFill('BTC/CAD', 'BUY', Money.fromString('0.005'), Money.fromString('40000'), Money.zero())
          .applyFill('ETH/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('2000'), Money.zero()),
      signals: { 'XRP/CAD': 'BUY' },
      tickers: { 'BTC/CAD': '40000', 'ETH/CAD': '3000', 'XRP/CAD': '2' },
    });
    const r = h.coordinator.evaluate(['XRP/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      // Full accounting: equity = 700 + 200(BTC 0.005*40000) + 150(ETH 0.05*3000) = 1050;
      // maxExposure = 525; current exposure = 350 => room = 175 => XRP notional <= 175.
      // Under the old bug (only XRP priced) equity/exposure would omit BTC+ETH and
      // allow up to ~350 notional.
      expect(r.selected.estimatedNotional.compareTo(Money.fromString('175.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('TEST D: large external BTC is excluded from managed equity/exposure', () => {
    // external BTC 5.0 (huge). Managed ETH 0.1 @ 2000. Evaluate SOL.
    const h = build({
      managed: (p) =>
        p
          .applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.fromString('0'))
          .withExternalSnapshot(new Map([['BTC/CAD', Money.fromString('5.0')]])),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'BTC/CAD': '45000', 'ETH/CAD': '3000', 'SOL/CAD': '100' },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    // External BTC (5*45000=225000) must NOT inflate exposure: equity=800+300=1100.
    // maxExposure=550; ETH exposure=300; room=250 => SOL qty 2.5 (same as TEST A/B).
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      expect(r.selected.estimatedNotional.compareTo(Money.fromString('250.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('TEST E: a candidate with no existing position is still included and sized correctly', () => {
    const h = build({
      managed: (p) => p,
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'SOL/CAD': '100' },
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      // equity = cash 1000; maxExposure = 500; exposure 0 => SOL notional = min(per-asset 0.5*1000=500, exposure 500) = 500 => qty 5.
      expect(r.selected.quantity.toFixed(8)).toBe('5.00000000');
    }
  });

  it('TEST F: fail-closed when a managed position cannot be valued (no ticker)', () => {
    // Managed ETH position exists but the market source has NO ETH ticker.
    const h = build({
      managed: (p) => p.applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('2000'), Money.zero()),
      signals: { 'SOL/CAD': 'BUY' },
      tickers: { 'SOL/CAD': '100' }, // ETH/CAD deliberately missing
    });
    const r = h.coordinator.evaluate(['SOL/CAD'], NOW);
    // valuationUnknown => portfolioExposure/Value null => RiskManager fails closed.
    expect(r.selected).toBeNull();
    // The ETH candidate evaluation must not silently treat ETH as zero.
    const ethEval = r.evaluated.find((e) => e.symbol === 'SOL/CAD');
    if (ethEval?.decision && !ethEval.decision.approved) {
      expect(['UNKNOWN_EXPOSURE', 'UNKNOWN_PORTFOLIO_VALUE']).toContain(ethEval.decision.reason);
    }
  });

  it('REG: SELL of a managed position is still bounded by the managed quantity (not external)', () => {
    // Managed BTC 0.25; external BTC 0.75 on the exchange; SELL signal on BTC.
    const h = build({
      managed: (p) =>
        p
          .applyFill('BTC/CAD', 'BUY', Money.fromString('0.25'), Money.fromString('40000'), Money.zero())
          .withExternalSnapshot(new Map([['BTC/CAD', Money.fromString('0.75')]])),
      signals: { 'BTC/CAD': 'SELL' },
      tickers: { 'BTC/CAD': '40000' },
    });
    const r = h.coordinator.evaluate(['BTC/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    if (r.selected) {
      expect(r.selected.quantity.toFixed(8)).toBe('0.25000000'); // never 1.0
    }
  });
});
