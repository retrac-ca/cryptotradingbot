import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PaperEngine } from '../../../src/engine/PaperEngine.js';
import type { PaperEngineStatus } from '../../../src/engine/PaperEngine.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { MarketDataProvider } from '../../../src/marketdata/types.js';
import type { Candle, MarketInfo, Ticker } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';

const NOW = 1_700_000_000_000;

const market: MarketInfo = {
  symbol: 'BTC/CAD',
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'),
  minOrderQuote: Money.fromString('1'),
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

const riskConfig: RiskConfig = {
  maxTradeAmount: Money.fromString('1000000'),
  maxPositionSizeFraction: 0.1,
  maxPortfolioExposureFraction: 1,
  maxDailyLossFraction: 1,
  maxDrawdownFraction: 1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 1,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

/** Always holds, so a cycle produces NO TRADE. */
const holdStrategy: Strategy = {
  id: 'hold',
  name: 'Hold',
  timeframe: '5m',
  warmupCandles: 2,
  describe: () => 'hold',
  evaluate: (ctx) => signal(ctx.symbol, 'HOLD'),
};

function candle(endMs: number): Candle {
  const m = Money.fromString('100');
  return {
    symbol: 'BTC/CAD',
    timeframe: '5m',
    timestampMs: endMs,
    open: m,
    high: m,
    low: m,
    close: m,
    baseVolume: Money.zero(),
  };
}

function ticker(): Ticker {
  const p = Money.fromString('100');
  return {
    symbol: 'BTC/CAD',
    bid: p,
    ask: p,
    last: p,
    open: p,
    high: p,
    low: p,
    baseVolume: Money.zero(),
    quoteVolume: Money.zero(),
    timestampMs: NOW,
    observedAtMs: NOW,
  };
}

function build() {
  const statuses: PaperEngineStatus[] = [];
  const exchange = new FakeExchange({ markets: { 'BTC/CAD': market } });
  exchange.setTicker('BTC/CAD', ticker());

  const candles: Candle[] = [candle(NOW - 300_000), candle(NOW - 240_000), candle(NOW - 60_000)];
  const marketData: MarketDataProvider = {
    symbols: ['BTC/CAD'],
    getTicker: () => ticker(),
    getOrderBook: () => null,
    getCandles: () => candles,
    isStale: () => false,
    lastError: () => null,
  };

  const engine = new PaperEngine({
    logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } } as never,
    marketData,
    exchange,
    strategy: holdStrategy,
    riskManager: new RiskManager(riskConfig),
    portfolio: Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])),
    store: null,
    paperConfig: { feeFraction: 0, slippageFraction: 0, fillFraction: 1 },
    evaluateIntervalMs: 60_000,
    symbols: ['BTC/CAD'],
    timeframe: '5m',
    freshnessPolicy: { maxQuoteAgeMs: 60_000, maxTransportAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 },
    candleMaxAgeMs: 3 * 300_000,
    onStatus: (s) => statuses.push(s),
  });

  return { engine, statuses };
}

describe('PaperEngine status heartbeat', () => {
  it('emits a running status with equity + cash on start, and stopped on stop', async () => {
    const { engine, statuses } = build();
    await engine.start();

    expect(statuses.length).toBeGreaterThanOrEqual(1);
    const started = statuses[statuses.length - 1]!;
    expect(started.running).toBe(true);
    expect(started.equity).toBe(Money.fromString('10000').toString());
    expect(started.cash).toEqual({ CAD: Money.fromString('10000').toString() });
    expect(started.ordersPlaced).toBe(0);

    engine.stop();
    const stopped = statuses[statuses.length - 1]!;
    expect(stopped.running).toBe(false);
  });

  it('emits a status after every evaluation cycle', async () => {
    const { engine, statuses } = build();
    await engine.start();
    const before = statuses.length;
    await engine.evaluateOnce(NOW);
    expect(statuses.length).toBeGreaterThan(before);
    const last = statuses[statuses.length - 1]!;
    expect(last.running).toBe(true);
    expect(last.lastEvaluateMs).toBe(NOW);
    expect(last.lastEvaluateError).toBeNull();
    engine.stop();
  });
});
