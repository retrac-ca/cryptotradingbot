import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import type { Order } from '../../../src/order.js';

const LEDGER = '/tmp/opencode/reconcile-service-ledger.json';

function order(clientOrderId: string, exchangeOrderId: string | null, status: Order['status']): Order {
  return {
    clientOrderId,
    exchangeOrderId,
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    status,
    quantity: Money.fromString('0.1'),
    filledQuantity: status === 'FILLED' ? Money.fromString('0.1') : Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function service(exchange: FakeExchange): ReconcileService {
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  return new ReconcileService(exchange, store);
}

describe('ReconcileService — fetch exchange state and reconcile the ledger', () => {
  it('reports consistent when a known open order appears on the exchange', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '10000' }, orderBehavior: { kind: 'open' } });
    const svc = service(exchange);
    // Seed the ledger with an open order the exchange will also show.
    const store = new OrderStore(LEDGER);
    // FakeExchange stores open orders in its `orders` array; place (open) through it.
    await exchange.placeOrder({
      clientOrderId: 'c1',
      symbol: 'BTC/CAD',
      side: 'BUY',
      type: 'market',
      quantity: Money.fromString('0.1'),
      reason: 'test',
    });
    const placed = exchange.getOrders()[0]!;
    expect(placed.status).toBe('OPEN');
    const localOrder = order('c1', placed.exchangeOrderId ?? '1', 'OPEN');
    store.save(localOrder);

    const report = await svc.reconcile();
    expect(report.safeToTrade).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('fails closed (safeToTrade=false) when a read throws', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '10000' } });
    const svc = service(exchange);
    exchange.setFailures({ getOrderHistory: { kind: 'network' } });
    const report = await svc.reconcile();
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies[0]!.kind).toBe('CANNOT_DETERMINE');
  });

  it('flags a local open order missing on the exchange', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '10000' } });
    const svc = service(exchange);
    const store = new OrderStore(LEDGER);
    store.save(order('missing-on-exchange', '99', 'OPEN'));
    const report = await svc.reconcile();
    expect(report.safeToTrade).toBe(false);
    const kinds = report.discrepancies.map((d) => d.kind);
    expect(kinds).toContain('LOCAL_OPEN_MISSING_ON_EXCHANGE');
  });
});
