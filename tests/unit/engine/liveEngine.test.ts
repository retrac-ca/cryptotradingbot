import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ManagedStateStore } from '../../../src/persistence/ManagedStateStore.js';
import { ManualIntentStore } from '../../../src/manual/ManualIntentStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import { LiveOrderMonitor } from '../../../src/execution/LiveOrderMonitor.js';
import { createAutonomousLiveSession } from '../../../src/execution/AutonomousLiveSession.js';
import { LiveEngine } from '../../../src/engine/LiveEngine.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { MarketDataProvider } from '../../../src/marketdata/types.js';
import type { Candle, MarketInfo, Ticker } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

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

function riskConfig(): RiskConfig {
  return {
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
}

/** Buys once while flat, then holds. */
const buyOnceStrategy: Strategy = {
  id: 'buy-once',
  name: 'BuyOnce',
  timeframe: '5m',
  warmupCandles: 2,
  describe: () => 'buy once',
  evaluate: (ctx) => (ctx.position.quantity.isZero() ? signal(ctx.symbol, 'BUY', { reason: 'test' }) : signal(ctx.symbol, 'HOLD')),
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

interface Harness {
  engine: LiveEngine;
  exchange: FakeExchange;
}

function build(overrides: { killSwitch?: boolean; unknownSubmissions?: boolean } = {}): Harness {
  const dir = dirname(statePath('liveengine', 'x.json'));
  const orders = new OrderStore(join(dir, 'order-ledger.json'));
  const live = new ManagedStateStore(join(dir, 'live-managed.json'));
  const manualIntents = new ManualIntentStore(join(dir, 'manual-intents.json'));
  // Seed managed deployable quote.
  live.save(Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])).stateModel);

  const exchange = new FakeExchange({
    balances: { CAD: '1000' },
    markets: { 'BTC/CAD': market },
    orderBehavior: { kind: 'fill' },
    unknownOrderSubmissions: overrides.unknownSubmissions ?? false,
  });
  exchange.setTicker('BTC/CAD', ticker());

  const riskManager = new RiskManager(riskConfig());
  const session = createAutonomousLiveSession({
    type: 'limit',
    tif: 'IOC',
    sides: ['BUY', 'SELL'],
    maxBaseQuantity: Money.fromString('1'),
    maxQuoteNotional: Money.fromString('1000'),
    maxSessionQuoteNotional: Money.fromString('5000'),
    maxSessionOrders: 5,
    expiresAtMs: Date.now() + 3_600_000,
  });

  const liveOrderEngine = new LiveOrderEngine(exchange, orders, new ReconcileService(exchange, orders), riskManager, {
    gate: { tradingMode: 'live', realFundsAtRisk: true },
    // The engine refuses to construct while the kill switch is on (production
    // checks it earlier); the LiveEngine-level kill switch is exercised instead.
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000'),
    maxLiveBaseQuantity: Money.fromString('1'),
    autonomousLiveSession: session,
  });
  const monitor = new LiveOrderMonitor({ stateDir: dir, orders, live, adapter: exchange, nowMs: () => NOW });

  const candles: Candle[] = [candle(NOW - 300_000), candle(NOW - 240_000), candle(NOW - 60_000)];
  const marketData: MarketDataProvider = {
    symbols: ['BTC/CAD'],
    getTicker: () => ticker(),
    getOrderBook: () => null,
    getCandles: () => candles,
    isStale: () => false,
    lastError: () => null,
  };

  const engine = new LiveEngine({
    logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } } as never,
    marketData,
    exchange,
    strategy: buyOnceStrategy,
    riskManager,
    orders,
    live,
    manualIntents,
    stateDir: dir,
    liveOrderEngine,
    monitor,
    evaluateIntervalMs: 60_000,
    symbols: ['BTC/CAD'],
    timeframe: '5m',
    freshnessPolicy: { maxQuoteAgeMs: 60_000, maxTransportMaxAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 },
    candleMaxAgeMs: 3 * 300_000,
    quoteCurrencies: new Set(['CAD']),
    killSwitch: overrides.killSwitch ?? false,
    nowMs: () => NOW,
  });

  return { engine, exchange };
}

describe('LiveEngine — autonomous live loop (FakeExchange)', () => {
  it('places exactly one LIMIT IOC order for an approved BUY signal', async () => {
    const { engine, exchange } = build();
    await engine.evaluateOnce(NOW);
    expect(exchange.submittedOrders).toHaveLength(1);
    const o = exchange.submittedOrders[0]!;
    expect(o.side).toBe('BUY');
    expect(o.type).toBe('limit');
    expect(o.tif).toBe('IOC');
    expect(engine.status.ordersPlaced).toBe(1);
    expect(engine.status.halted).toBe(false);
  });

  it('places nothing while the kill switch is active', async () => {
    const { engine, exchange } = build({ killSwitch: true });
    await engine.evaluateOnce(NOW);
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(engine.status.halted).toBe(true);
  });

  it('halts on an ambiguous (UNKNOWN) submission and does not retry', async () => {
    const { engine, exchange } = build({ unknownSubmissions: true });
    await engine.evaluateOnce(NOW);
    expect(engine.status.halted).toBe(true);
    expect(exchange.submittedOrders).toHaveLength(1);
    // A second cycle must not place another order while halted.
    await engine.evaluateOnce(NOW);
    expect(exchange.submittedOrders).toHaveLength(1);
  });
});
