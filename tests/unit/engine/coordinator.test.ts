import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskDecision, RiskApproval } from '../../../src/risk/Reason.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';
import { signal } from '../../../src/strategy/Signal.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { FreshnessPolicy } from '../../../src/marketdata/freshness.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../../src/types.js';

const TW = '5m';

const freshnessPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: 60_000,
  maxTransportAgeMs: 60_000,
  maxAcceptableFutureSkewMs: 120_000,
};

function market(symbol: string): MarketInfo {
  return {
    symbol,
    exchangeId: '1',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 2,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.000001'),
    minOrderQuote: null,
    supportsMarketOrders: true,
    feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  };
}

function ticker(symbol: string, bid: string, ask: string, ts: number): Ticker {
  return {
    symbol,
    bid: Money.fromString(bid),
    ask: Money.fromString(ask),
    last: Money.fromString(bid),
    open: null,
    high: null,
    low: null,
    baseVolume: null,
    quoteVolume: null,
    timestampMs: ts,
    observedAtMs: ts,
  };
}

const riskConfig: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.1,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 1,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

/** RiskManager whose decisions are pre-gridded (bypasses real validation). */
class GriddedRisk extends RiskManager {
  grid = new Map<string, RiskDecision>();
  constructor() {
    super(riskConfig);
  }
  override evaluate(ctx: { symbol: string }): RiskDecision {
    return this.grid.get(ctx.symbol) ?? {
      approved: false,
      symbol: ctx.symbol,
      side: null,
      reason: 'NO_ACTION',
      appliedLimits: this.appliedLimitsForTest(),
    };
  }
  appliedLimitsForTest() {
    return {
      maxTradeAmount: Money.zero(),
      maxPositionSizeFraction: 0.1,
      maxPortfolioExposureFraction: 0.5,
      maxDailyLossFraction: 0.05,
      maxDrawdownFraction: 0.1,
      cooldownAfterLossMs: 0,
      maxOpenPositions: 1,
      killSwitchActive: false,
    };
  }
}

/** Strategy whose signal is pre-programmed per symbol. */
class GridStrategy implements Strategy {
  readonly id = 'fake';
  readonly name = 'fake';
  readonly timeframe: Timeframe = TW;
  readonly warmupCandles = 1;
  grid = new Map<string, Signal>();
  evaluate(ctx: StrategyContext): Signal {
    return this.grid.get(ctx.symbol) ?? signal(ctx.symbol, 'HOLD', { reason: 'default' }, ctx.nowMs);
  }
  describe(): string {
    return 'fake';
  }
}

function approved(symbol: string, side: 'BUY' | 'SELL', quantity: string, price: string): RiskApproval {
  const qty = Money.fromString(quantity);
  const pr = Money.fromString(price);
  return {
    approved: true,
    symbol,
    side,
    quantity: qty,
    estimatedNotional: qty.mul(pr),
    price: pr,
    reason: 'APPROVED',
    appliedLimits: riskConfig,
  };
}

function port(seedCad: string, ext: Record<string, string> = {}): Portfolio {
  const cash = new Map<string, Money>();
  cash.set('CAD', Money.fromString(seedCad));
  let p = Portfolio.empty(cash);
  p = p.withExternalSnapshot(new Map(Object.entries(ext).map(([s, q]) => [s, Money.fromString(q)])));
  return p;
}

interface Harness {
  coordinator: MarketCoordinator;
  risk: GriddedRisk;
  strategy: GridStrategy;
  portfolio: Portfolio;
  source: {
    infos: Map<string, MarketInfo>;
    tickers: Map<string, Ticker>;
    candles: Map<string, Candle[]>;
  };
}

function build(seedCad = '1000', ext: Record<string, string> = {}): Harness {
  const portfolio = port(seedCad, ext);
  const risk = new GriddedRisk();
  const strategy = new GridStrategy();
  const source = { infos: new Map<string, MarketInfo>(), tickers: new Map<string, Ticker>(), candles: new Map<string, Candle[]>() };
  const coordinator = new MarketCoordinator({
    strategy,
    riskManager: risk,
    getPortfolio: () => portfolio,
    timeframe: TW,
    marketSource: {
      getMarketInfo: (s) => source.infos.get(s) ?? market(s),
      getTicker: (s) => source.tickers.get(s) ?? null,
      getCandles: (s) => source.candles.get(s) ?? [],
    },
    freshnessPolicy,
  });
  return { coordinator, risk, strategy, portfolio, source };
}

const NOW = 1_000_000;

describe('MarketCoordinator', () => {
  it('evaluates multiple markets and continues after one is rejected', () => {
    const h = build();
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'BUY', {}, NOW));
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('BTC/CAD', { approved: false, symbol: 'BTC/CAD', side: 'BUY', reason: 'MAX_POSITION_EXCEEDED', appliedLimits: riskConfig });
    h.risk.grid.set('ETH/CAD', approved('ETH/CAD', 'BUY', '0.1', '3000'));

    const r = h.coordinator.evaluate(['BTC/CAD', 'ETH/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    expect(r.selected!.symbol).toBe('ETH/CAD');
    // BTC was evaluated (rejected) — the cycle did NOT stop at BTC.
    expect(r.evaluated.find((e) => e.symbol === 'BTC/CAD')!.decision!.approved).toBe(false);
  });

  it('selects at most one trade even when several assets signal simultaneously', () => {
    const h = build();
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'BUY', {}, NOW));
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'BUY', {}, NOW));
    h.strategy.grid.set('ADA/CAD', signal('ADA/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('BTC/CAD', approved('BTC/CAD', 'BUY', '0.1', '40000'));
    h.risk.grid.set('ETH/CAD', approved('ETH/CAD', 'BUY', '0.1', '3000'));
    h.risk.grid.set('ADA/CAD', approved('ADA/CAD', 'BUY', '10', '0.5'));

    const r = h.coordinator.evaluate(['BTC/CAD', 'ETH/CAD', 'ADA/CAD'], NOW);
    expect(r.selected).not.toBeNull();
    // Only one selected despite three approvals.
    expect(r.evaluated.filter((e) => e.decision?.approved)).toHaveLength(3);
  });

  it('ranks BUYs deterministically by lower relative spread, then symbol', () => {
    const h = build();
    h.source.tickers.set('BTC/CAD', ticker('BTC/CAD', '100', '101', NOW)); // spread ~0.0099
    h.source.tickers.set('ETH/CAD', ticker('ETH/CAD', '3000', '3090', NOW)); // spread ~0.0295
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'BUY', {}, NOW));
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('BTC/CAD', approved('BTC/CAD', 'BUY', '0.1', '100'));
    h.risk.grid.set('ETH/CAD', approved('ETH/CAD', 'BUY', '0.1', '3000'));
    const r = h.coordinator.evaluate(['ETH/CAD', 'BTC/CAD'], NOW);
    expect(r.selected!.symbol).toBe('BTC/CAD'); // tighter spread wins
  });

  it('prioritizes an approved SELL exit over new BUYs', () => {
    const h = build();
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'SELL', {}, NOW));
    h.strategy.grid.set('SOL/CAD', signal('SOL/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('ETH/CAD', approved('ETH/CAD', 'SELL', '0.1', '3000'));
    h.risk.grid.set('SOL/CAD', approved('SOL/CAD', 'BUY', '0.1', '150'));
    const r = h.coordinator.evaluate(['ETH/CAD', 'SOL/CAD'], NOW);
    expect(r.selected!.side).toBe('SELL');
    expect(r.selected!.symbol).toBe('ETH/CAD');
  });

  it('returns NO TRADE when every market is HOLD or rejected', () => {
    const h = build();
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'HOLD', {}, NOW));
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('ETH/CAD', { approved: false, symbol: 'ETH/CAD', side: 'BUY', reason: 'UNKNOWN_PRICE', appliedLimits: riskConfig });
    const r = h.coordinator.evaluate(['BTC/CAD', 'ETH/CAD'], NOW);
    expect(r.selected).toBeNull();
  });

  it('never manufactures a signal: HOLD is never a candidate', () => {
    const h = build();
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'HOLD', {}, NOW));
    const r = h.coordinator.evaluate(['BTC/CAD'], NOW);
    expect(r.evaluated[0]!.signalType).toBe('HOLD');
    expect(r.selected).toBeNull();
  });

  it('uses the managed position for the strategy (external is invisible)', () => {
    const h = build('1000', { 'BTC/CAD': '0.25' }); // external BTC 0.25
    let seenQty = '' as string;
    const spyStrategy = new GridStrategy();
    const original = spyStrategy.evaluate.bind(spyStrategy);
    spyStrategy.evaluate = (ctx: StrategyContext) => {
      seenQty = ctx.position.quantity.toString();
      return original(ctx);
    };
    spyStrategy.grid.set('BTC/CAD', signal('BTC/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('BTC/CAD', approved('BTC/CAD', 'BUY', '0.1', '40000'));

    const coord2 = new MarketCoordinator({
      strategy: spyStrategy,
      riskManager: h.risk,
      getPortfolio: () => h.portfolio,
      timeframe: TW,
      marketSource: {
        getMarketInfo: (s) => h.source.infos.get(s) ?? market(s),
        getTicker: (s) => h.source.tickers.get(s) ?? null,
        getCandles: (s) => h.source.candles.get(s) ?? [],
      },
      freshnessPolicy,
    });
    coord2.evaluate(['BTC/CAD'], NOW);
    expect(seenQty).toBe('0.00000000'); // managed 0 despite external 0.25
  });

  it('is deterministic regardless of input order', () => {
    const h = build();
    h.strategy.grid.set('BTC/CAD', signal('BTC/CAD', 'BUY', {}, NOW));
    h.strategy.grid.set('ETH/CAD', signal('ETH/CAD', 'BUY', {}, NOW));
    h.risk.grid.set('BTC/CAD', approved('BTC/CAD', 'BUY', '0.1', '40000'));
    h.risk.grid.set('ETH/CAD', approved('ETH/CAD', 'BUY', '0.1', '3000'));
    const a = h.coordinator.evaluate(['ETH/CAD', 'BTC/CAD'], NOW);
    const b = h.coordinator.evaluate(['BTC/CAD', 'ETH/CAD'], NOW);
    expect(a.selected!.symbol).toBe(b.selected!.symbol);
  });
});
