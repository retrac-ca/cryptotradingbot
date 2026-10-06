import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  ManagedStateStore,
  OrderStore,
  PaperStateStore,
  StateInitMarker,
} from '../../../src/persistence/index.js';
import { ManualIntentStore } from '../../../src/manual/ManualIntentStore.js';
import { createReadOnlyExchangeAdapter, MonitoringService } from '../../../src/monitoring/index.js';
import type { MonitoringServiceDeps } from '../../../src/monitoring/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { MarketDataProvider } from '../../../src/marketdata/types.js';
import type { OrderBook, Ticker } from '../../../src/types.js';
import type { NewOrder, Order } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';

const NOW = 1_000_000;
const now = () => NOW;

let dir: string;
let paths: { paper: string; live: string; orders: string; manual: string; init: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retrac-monitoring-'));
  paths = {
    paper: join(dir, 'paper-state.json'),
    live: join(dir, 'live-managed-state.json'),
    orders: join(dir, 'order-ledger.json'),
    manual: join(dir, 'manual-intents.json'),
    init: join(dir, '.init.json'),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    tradingMode: 'paper',
    exchange: 'ndax',
    killSwitch: false,
    enableAuthenticatedReads: false,
    strategy: 'moving-average-crossover',
    timeframe: '5m',
    tradingPairs: ['BTC/CAD'],
    universeMarkets: ['BTC/CAD'],
    marketDataMaxAgeMs: 60_000,
    marketDataTransportMaxAgeMs: 60_000,
    maxClockSkewMs: 120_000,
    // Secret-bearing fields — MUST never appear in the snapshot output.
    ndaxApiKey: 'SECRET_API_KEY_VALUE',
    ndaxApiSecret: 'SECRET_API_SECRET_VALUE',
    ndaxUserId: 'NDAX_USER_ID_SECRET',
    ndaxUserName: 'secret-user@example.com',
    ndaxAccountId: 449,
    ...over,
  } as BotConfig;
}

function makeService(over: Partial<MonitoringServiceDeps> = {}): MonitoringService {
  return new MonitoringService({
    config: makeConfig(),
    version: '1.2.1',
    orders: new OrderStore(paths.orders),
    paper: new PaperStateStore(paths.paper),
    live: new ManagedStateStore(paths.live),
    manualIntents: new ManualIntentStore(paths.manual),
    initMarker: new StateInitMarker(paths.init),
    stateDir: dir,
    nowMs: now,
    ...over,
  });
}

function savePaper(p: Portfolio, ids: string[] = ['p1']): void {
  new PaperStateStore(paths.paper).save(p.stateModel, ids);
}

function saveLive(p: Portfolio): void {
  new ManagedStateStore(paths.live).save(p.stateModel);
}

function sampleOrder(): Order {
  return {
    clientOrderId: 'live-BTCCAD-1',
    exchangeOrderId: '26177556994',
    symbol: 'BTC/CAD',
    side: 'SELL',
    type: 'limit',
    status: 'FILLED',
    quantity: Money.fromString('0.01'),
    filledQuantity: Money.fromString('0.01'),
    averagePrice: Money.fromString('100000'),
    price: Money.fromString('100000'),
    fills: [
      {
        price: Money.fromString('100000'),
        quantity: Money.fromString('0.01'),
        fee: Money.zero(),
        feeCurrency: 'quote',
        timestampMs: 123,
        executionId: 'exec-1',
      },
    ],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test order',
    createdAtMs: 100,
    updatedAtMs: 200,
    resolution: null,
  };
}

function ticker(over: Partial<Ticker> = {}): Ticker {
  return {
    symbol: 'BTC/CAD',
    bid: null,
    ask: null,
    last: null,
    open: null,
    high: null,
    low: null,
    baseVolume: null,
    quoteVolume: null,
    timestampMs: NOW,
    observedAtMs: NOW,
    ...over,
  };
}

function fakeMarketData(data: {
  ticker?: Ticker | null;
  book?: OrderBook | null;
  lastError?: Error | null;
}): MarketDataProvider {
  return {
    symbols: ['BTC/CAD'],
    getTicker: () => data.ticker ?? null,
    getOrderBook: () => data.book ?? null,
    getCandles: () => [],
    isStale: () => true,
    lastError: () => data.lastError ?? null,
  };
}

describe('MonitoringService — read-only read model', () => {
  it('1. reads managed LIVE state without mutating it', async () => {
    const live = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])).applyFill(
      'BTC/CAD',
      'BUY',
      Money.fromString('0.25'),
      Money.fromString('40000'),
      Money.zero(),
    );
    saveLive(live);
    const before = readFileSync(paths.live, 'utf8');

    const snapshot = await makeService().getSnapshot();

    expect(snapshot.portfolios.live.status).toBe('OK');
    expect(snapshot.portfolios.live.positions).toHaveLength(1);
    expect(snapshot.portfolios.live.positions![0]!.symbol).toBe('BTC/CAD');
    expect(snapshot.portfolios.live.positions![0]!.quantity).toBe('0.25000000');
    // No mutation: state file bytes are identical and no temp file was left.
    expect(readFileSync(paths.live, 'utf8')).toBe(before);
    expect(() => readFileSync(`${paths.live}.tmp`, 'utf8')).toThrow();
  });

  it('2. keeps PAPER, LIVE, external, and authorized-external data separate', async () => {
    savePaper(
      Portfolio.empty(new Map([['CAD', Money.fromString('5000')]])).applyFill(
        'BTC/CAD',
        'BUY',
        Money.fromString('0.5'),
        Money.fromString('40000'),
        Money.zero(),
      ),
    );
    saveLive(
      Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]), {
        externalSnapshot: new Map([['BTC/CAD', Money.fromString('0.2')]]),
        authorizedExternal: new Set(['BTC/CAD']),
      }).applyFill('ETH/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('3000'), Money.zero()),
    );

    const { portfolios } = await makeService().getSnapshot();

    expect(portfolios.paper.positions!.map((p) => p.symbol)).toEqual(['BTC/CAD']);
    expect(portfolios.live.positions!.map((p) => p.symbol)).toEqual(['ETH/CAD']);
    // Paper holdings never leak into live, and vice-versa.
    expect(portfolios.live.positions!.some((p) => p.symbol === 'BTC/CAD')).toBe(false);
    expect(portfolios.paper.externalSnapshot).toEqual({});
    expect(portfolios.live.externalSnapshot).toEqual({ 'BTC/CAD': '0.20000000' });
    expect(portfolios.live.authorizedExternal).toEqual(['BTC/CAD']);
  });

  it('3. exposes order-ledger information without modifying orders', async () => {
    new OrderStore(paths.orders).save(sampleOrder());
    const before = readFileSync(paths.orders, 'utf8');

    const snapshot = await makeService().getSnapshot();

    expect(snapshot.orders.status).toBe('OK');
    expect(snapshot.orders.totalCount).toBe(1);
    const order = snapshot.orders.orders![0]!;
    expect(order.clientOrderId).toBe('live-BTCCAD-1');
    expect(order.exchangeOrderId).toBe('26177556994');
    expect(order.side).toBe('SELL');
    expect(order.type).toBe('limit');
    expect(order.status).toBe('FILLED');
    expect(order.quantity).toBe('0.01000000');
    expect(order.limitPrice).toBe('100000.00000000');
    expect(order.fills[0]!.executionId).toBe('exec-1');
    expect(readFileSync(paths.orders, 'utf8')).toBe(before);
  });

  it('4. never contains secret config fields or account identifiers', async () => {
    const snapshot = await makeService().getSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain('SECRET_API_KEY_VALUE');
    expect(serialized).not.toContain('SECRET_API_SECRET_VALUE');
    expect(serialized).not.toContain('secret-user@example.com');
    expect(serialized).not.toContain('NDAX_USER_ID_SECRET');
    expect(serialized).not.toContain('ndaxApiKey');
    expect(serialized).not.toContain('ndaxApiSecret');
    // The whitelisted non-secret status is present.
    expect(snapshot.system.config.enableAuthenticatedReads).toBe(false);
    expect(snapshot.system.config.version).toBe('1.2.1');
  });

  it('5. does not convert corrupt state into empty/default state', async () => {
    writeFileSync(paths.live, 'this is definitely not valid json');
    writeFileSync(paths.orders, '{ broken');

    const snapshot = await makeService().getSnapshot();

    expect(snapshot.portfolios.live.status).toBe('CORRUPT');
    expect(snapshot.portfolios.live.positions).toBeNull();
    expect(snapshot.portfolios.live.cash).toBeNull();
    expect(snapshot.orders.status).toBe('CORRUPT');
    expect(snapshot.orders.orders).toBeNull();
    expect(snapshot.system.recovery.status).toBe('HALTED');
  });

  it('6. represents missing state as missing (never empty/default)', async () => {
    const snapshot = await makeService().getSnapshot();

    expect(snapshot.portfolios.paper.status).toBe('MISSING');
    expect(snapshot.portfolios.live.status).toBe('MISSING');
    expect(snapshot.orders.status).toBe('MISSING');
    expect(snapshot.portfolios.paper.positions).toBeNull();
    expect(snapshot.portfolios.live.positions).toBeNull();
    expect(snapshot.orders.orders).toBeNull();
    expect(snapshot.orders.totalCount).toBeNull();
  });

  it('7a. reports unavailable market data as UNAVAILABLE/stale when no provider runs', async () => {
    const snapshot = await makeService().getSnapshot();
    expect(snapshot.market.status).toBe('UNAVAILABLE');
    expect(snapshot.market.stale).toBe(true);
    expect(snapshot.market.last).toBeNull();
  });

  it('7b. reports a stale snapshot as stale (using the existing freshness rules)', async () => {
    const staleTicker = ticker({
      bid: Money.fromString('99'),
      ask: Money.fromString('100'),
      last: Money.fromString('99.5'),
      timestampMs: NOW - 5000,
      observedAtMs: NOW - 5000,
    });
    const service = makeService({
      marketData: fakeMarketData({ ticker: staleTicker }),
      config: makeConfig({ marketDataMaxAgeMs: 1000, marketDataTransportMaxAgeMs: 1000 }),
    });

    const { market } = await service.getSnapshot();
    expect(market.status).toBe('OK');
    expect(market.stale).toBe(true);
    expect(market.staleReason).toBe('QUOTE_STALE');
    expect(market.spread).toBe('1.00000000');
    expect(market.spreadPct).not.toBeNull();
  });

  it('7c. reports a fresh snapshot as fresh', async () => {
    const freshTicker = ticker({
      bid: Money.fromString('99'),
      ask: Money.fromString('100'),
      last: Money.fromString('99.5'),
      timestampMs: NOW - 10,
      observedAtMs: NOW - 10,
    });
    const service = makeService({ marketData: fakeMarketData({ ticker: freshTicker }) });

    const { market } = await service.getSnapshot();
    expect(market.status).toBe('OK');
    expect(market.stale).toBe(false);
    expect(market.staleReason).toBeNull();
  });

  it('8. cannot expose order placement/cancellation through its adapter or service', async () => {
    const fake = new FakeExchange({ balances: { CAD: '1000' } });
    const readOnly = createReadOnlyExchangeAdapter(fake);

    await expect(readOnly.getBalances()).resolves.toBeInstanceOf(Array);
    const newOrder: NewOrder = {
      symbol: 'BTC/CAD',
      side: 'BUY',
      type: 'limit',
      quantity: Money.fromString('0.01'),
      price: Money.fromString('10000'),
      clientOrderId: 'x',
      reason: 'test',
    };
    await expect(readOnly.placeOrder(newOrder)).rejects.toThrow(/read-only monitoring/);
    await expect(readOnly.cancelOrder('BTC/CAD', '1')).rejects.toThrow(/read-only monitoring/);

    const service = makeService({ adapter: fake });
    const asRecord = service as unknown as Record<string, unknown>;
    expect(asRecord.placeOrder).toBeUndefined();
    expect(asRecord.cancelOrder).toBeUndefined();
  });

  it('9a. surfaces reconciliation errors instead of swallowing them', async () => {
    const service = makeService({
      adapter: new FakeExchange(),
      reconcileFn: async () => {
        throw new Error('reconcile exploded');
      },
    });

    const result = await service.getReconciliation();
    expect(result.status).toBe('ERROR');
    expect(result.error).toContain('reconcile exploded');
    expect(result.result).toBeNull();
  });

  it('9b. returns the read-only reconciliation result when it succeeds', async () => {
    const service = makeService({
      adapter: new FakeExchange(),
      reconcileFn: async () => ({
        status: 'READY',
        reasons: [],
        readFailures: [],
        orderFindings: [],
        executionFindings: [],
        reservationFindings: [],
        balanceFindings: [],
        operatorFindings: [],
        commitCandidates: [],
        reservationReleases: [],
        canCommit: false,
      }),
    });

    const result = await service.getReconciliation();
    expect(result.status).toBe('READY');
    expect(result.result).not.toBeNull();
    expect(result.provenance.kind).toBe('derived');
  });

  it('9c. reports reconciliation as UNAVAILABLE without an adapter', async () => {
    const result = await makeService().getReconciliation();
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.error).toContain('no exchange adapter');
  });

  it('10. populates snapshot/provenance timestamps', async () => {
    saveLive(Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])));
    const freshTicker = ticker({ last: Money.fromString('99.5'), timestampMs: NOW - 10, observedAtMs: NOW - 10 });
    const service = makeService({ marketData: fakeMarketData({ ticker: freshTicker }) });

    const snapshot = await service.getSnapshot();

    expect(snapshot.capturedAtMs).toBe(NOW);
    expect(snapshot.system.provenance.fetchedAtMs).toBe(NOW);
    expect(snapshot.portfolios.live.provenance.kind).toBe('managed_state');
    expect(snapshot.portfolios.live.provenance.asOfMs).toBeGreaterThan(0);
    expect(snapshot.portfolios.live.provenance.fetchedAtMs).toBe(NOW);
    expect(snapshot.orders.provenance.kind).toBe('managed_state');
    // A persisted value is never labelled as a current exchange read.
    expect(snapshot.portfolios.live.provenance.kind).not.toBe('exchange_read');
    expect(snapshot.market.provenance.kind).toBe('exchange_read');
    expect(snapshot.market.provenance.asOfMs).toBe(NOW - 10);
  });

  it('reports explicit read-only exchange health', async () => {
    const service = makeService({ adapter: new FakeExchange({ healthLatencyMs: 7 }) });
    const health = await service.getHealth();
    expect(health.status).toBe('OK');
    expect(health.connected).toBe(true);
    expect(health.latencyMs).toBe(7);
    expect(health.provenance.kind).toBe('exchange_read');
  });

  it('surfaces exchange health errors', async () => {
    const service = makeService({
      adapter: new FakeExchange({ failures: { health: { kind: 'network' } } }),
    });
    const health = await service.getHealth();
    expect(health.status).toBe('ERROR');
    expect(health.connected).toBeNull();
    expect(health.error).toContain('simulated network failure');
  });
});
