/**
 * LiveOrderMonitor — bounded read-only lifecycle observer tests.
 *
 * The monitor must advance local LIVE order state ONLY on verified exchange
 * evidence, never place/cancel/retry, never fabricate a fill, never release a
 * reservation without the existing proven rules, and never enable live trading.
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ManagedStateStore } from '../../../src/persistence/ManagedStateStore.js';
import { LiveOrderMonitor } from '../../../src/execution/LiveOrderMonitor.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Order, OrderStatus } from '../../../src/order.js';
import type { AccountTrade, MarketInfo } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { toReadOnlyAdapter } from '../../../src/cli/manual-cmd.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('live-monitor', 'ledger.json');
const LIVE = statePath('live-monitor', 'live.json');
const OID = 'live-BTCCAD-11111111-1111-4111-8111-111111111111';
const EXCH = '555';

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
  baseProductId: '1',
  quoteProductId: '2',
};

function mkLocalOrder(status: OrderStatus, over: Partial<Order> = {}): Order {
  return {
    clientOrderId: OID,
    exchangeOrderId: EXCH,
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'limit',
    status,
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: Money.fromString('40000'),
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'monitor-test',
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...over,
  };
}

function mkExchangeOrder(status: OrderStatus, over: Partial<Order> = {}): Order {
  return mkLocalOrder(status, { clientOrderId: OID, ...over });
}

function mkTrade(over: Partial<AccountTrade> = {}): AccountTrade {
  return {
    executionId: 'exec-1',
    tradeId: 'exec-1',
    orderId: EXCH,
    clientOrderId: null,
    symbol: 'BTC/CAD',
    instrumentId: '1',
    accountId: '449',
    subAccountId: null,
    side: 'BUY',
    quantity: Money.fromString('0.1'),
    remainingQuantity: Money.zero(),
    price: Money.fromString('40000'),
    value: Money.fromString('4000'),
    tradeTimeMs: 5000,
    fee: Money.fromString('8'),
    feeProductId: '2',
    orderOriginator: null,
    ...over,
  };
}

interface Harness {
  exchange: FakeExchange;
  orders: OrderStore;
  live: ManagedStateStore;
  monitor: LiveOrderMonitor;
}

function buildHarness(opts: {
  local?: Order;
  exchangeOrders?: Order[];
  trades?: AccountTrade[];
  withReservation?: boolean;
} = {}): Harness {
  rmSync(LEDGER, { force: true });
  rmSync(LIVE, { force: true });
  const orders = new OrderStore(LEDGER);
  if (opts.local) orders.save(opts.local);
  const live = new ManagedStateStore(LIVE);
  let portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
  if (opts.withReservation) {
    portfolio = portfolio.reserveOrder(OID, 'CAD', Money.fromString('4000'));
  }
  live.save(portfolio.stateModel);

  const exchange = new FakeExchange({
    balances: { CAD: '100000', BTC: '1' },
    markets: { 'BTC/CAD': market },
    tickers: { 'BTC/CAD': { symbol: 'BTC/CAD', bid: Money.fromString('40000'), ask: Money.fromString('40001'), last: Money.fromString('40000'), timestampMs: Date.now() } },
  });
  if (opts.exchangeOrders) exchange.seedOrders(opts.exchangeOrders);
  if (opts.trades) exchange.seedAccountTrades(opts.trades);

  const monitor = new LiveOrderMonitor({
    stateDir: dirname(LEDGER),
    orders,
    live,
    adapter: toReadOnlyAdapter(exchange),
  });
  return { exchange, orders, live, monitor };
}

function ledgerOrder(orders: OrderStore): Order {
  return orders.get(OID)!;
}

function liveReservation(): ReturnType<Portfolio['orderReservation']> {
  const store = new ManagedStateStore(LIVE);
  const r = store.load();
  if (r.status !== 'OK') return null;
  const pf = store.toPortfolio(r.data);
  return pf ? pf.orderReservation(OID) : null;
}

describe('LiveOrderMonitor — state advancement (verified exchange evidence)', () => {
  it('SUBMITTED → OPEN on verified exchange status', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('OPEN');
    expect(report.transitions[0]).toMatchObject({ from: 'SUBMITTED', to: 'OPEN' });
  });

  it('OPEN → PARTIALLY_FILLED on verified exchange status', async () => {
    const h = buildHarness({ local: mkLocalOrder('OPEN'), exchangeOrders: [mkExchangeOrder('PARTIALLY_FILLED', { filledQuantity: Money.fromString('0.05') })] });
    await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('PARTIALLY_FILLED');
  });

  it('OPEN → CANCELED with zero fill (reservation released once)', async () => {
    const h = buildHarness({ local: mkLocalOrder('OPEN'), exchangeOrders: [mkExchangeOrder('CANCELED')], withReservation: true });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('CANCELED');
    expect(report.releasedReservations).toContain(OID);
    expect(liveReservation()?.status).toBe('RELEASED');
  });

  it('OPEN → REJECTED', async () => {
    const h = buildHarness({ local: mkLocalOrder('OPEN'), exchangeOrders: [mkExchangeOrder('REJECTED')] });
    await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('REJECTED');
  });

  it('PARTIAL → additional proven execution discovered and applied once', async () => {
    const h = buildHarness({
      local: mkLocalOrder('PARTIALLY_FILLED', { filledQuantity: Money.fromString('0.05') }),
      exchangeOrders: [mkExchangeOrder('PARTIALLY_FILLED', { filledQuantity: Money.fromString('0.1') })],
      trades: [mkTrade({ executionId: 'exec-2', quantity: Money.fromString('0.05'), price: Money.fromString('40001') })],
      withReservation: true,
    });
    const report = await h.monitor.monitorOnce();
    expect(report.appliedExecutions).toContain(`${OID}:exec-2`);
    const report2 = await h.monitor.monitorOnce();
    expect(report2.appliedExecutions).toHaveLength(0); // idempotent
  });

  it('FILLED status with incomplete execution evidence does NOT fabricate a fill and retains the reservation', async () => {
    const h = buildHarness({
      local: mkLocalOrder('OPEN'),
      exchangeOrders: [mkExchangeOrder('FILLED', { filledQuantity: Money.fromString('0.1'), averagePrice: Money.fromString('40000') })],
      withReservation: true,
    });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('FILLED');
    expect(report.appliedExecutions).toHaveLength(0);
    expect(report.releasedReservations).toHaveLength(0);
    expect(liveReservation()?.status).toBe('ACTIVE'); // completeness unknown => retain
  });

  it('UNKNOWN with an exchangeOrderId is recovered to a known state', async () => {
    const h = buildHarness({ local: mkLocalOrder('UNKNOWN'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('OPEN');
  });

  it('UNKNOWN without an exchangeOrderId remains unresolved (no ClientOrderId reattachment)', async () => {
    const h = buildHarness({ local: mkLocalOrder('UNKNOWN', { exchangeOrderId: null }) });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('UNKNOWN');
    expect(report.unresolved).toContain(OID);
  });
});

describe('LiveOrderMonitor — fail-closed on read failures (no aggressive retry)', () => {
  it('status endpoint timeout leaves the order unchanged', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    h.exchange.setFailures({ getOrderStatus: { kind: 'timeout' } });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('SUBMITTED');
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('rate-limit response fails closed (order unchanged, no retry storm)', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    h.exchange.setFailures({ getOrderStatus: { kind: 'rateLimit' } });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('SUBMITTED');
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('malformed status response fails closed (order unchanged)', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    h.exchange.setFailures({ getOrderStatus: { kind: 'unknownOutcome' } });
    const report = await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('SUBMITTED');
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

describe('LiveOrderMonitor — restart, no regression, safety', () => {
  it('a monitor restart preserves the advanced state (no regression)', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('OPEN');
    // Fresh monitor reading the same durable ledger.
    const restart = new LiveOrderMonitor({
      stateDir: dirname(LEDGER),
      orders: new OrderStore(LEDGER),
      live: new ManagedStateStore(LIVE),
      adapter: toReadOnlyAdapter(h.exchange),
    });
    const report = await restart.monitorOnce();
    expect(ledgerOrder(new OrderStore(LEDGER)).status).toBe('OPEN');
    expect(report.transitions).toHaveLength(0); // already open, no regression
  });

  it('a reservation remains protected while the order is unresolved', async () => {
    const h = buildHarness({ local: mkLocalOrder('UNKNOWN', { exchangeOrderId: null }), withReservation: true });
    const report = await h.monitor.monitorOnce();
    expect(report.releasedReservations).toHaveLength(0);
    expect(liveReservation()?.status).toBe('ACTIVE');
  });

  it('terminal no-fill releases the reservation exactly once', async () => {
    const h = buildHarness({ local: mkLocalOrder('OPEN'), exchangeOrders: [mkExchangeOrder('CANCELED')], withReservation: true });
    const r1 = await h.monitor.monitorOnce();
    expect(r1.releasedReservations).toContain(OID);
    const r2 = await h.monitor.monitorOnce();
    expect(r2.releasedReservations).toHaveLength(0); // already released
  });

  it('never calls SendOrder (read-only proxy would throw; submittedOrders stays 0)', async () => {
    const h = buildHarness({ local: mkLocalOrder('SUBMITTED'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    await h.monitor.monitorOnce();
    expect(h.exchange.submittedOrders).toHaveLength(0);
  });

  it('never calls CancelOrder (order is not canceled by the monitor)', async () => {
    const h = buildHarness({ local: mkLocalOrder('OPEN'), exchangeOrders: [mkExchangeOrder('OPEN')] });
    await h.monitor.monitorOnce();
    expect(ledgerOrder(h.orders).status).toBe('OPEN');
  });

  it('the NDAX adapter still advertises supportsOrderPlacement=false', async () => {
    const { NdaxAdapter } = await import('../../../src/exchanges/ndax/NdaxAdapter.js');
    const adapter = new NdaxAdapter({ credentials: { apiKey: '', apiSecret: '', userId: '' } });
    expect(adapter.capabilities.supportsOrderPlacement).toBe(false);
  });

  it('two monitor cycles cannot double-account a fill (idempotent)', async () => {
    const h = buildHarness({
      local: mkLocalOrder('OPEN'),
      exchangeOrders: [mkExchangeOrder('FILLED', { filledQuantity: Money.fromString('0.1'), averagePrice: Money.fromString('40000') })],
      trades: [mkTrade()],
      withReservation: true,
    });
    const results = await Promise.allSettled([h.monitor.monitorOnce(), h.monitor.monitorOnce()]);
    let applied = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') applied += r.value.appliedExecutions.length;
    }
    // The proven execution is applied at most once (idempotent + mutation lock).
    expect(applied).toBeLessThanOrEqual(1);
  });
});
