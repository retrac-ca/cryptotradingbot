import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import type { Order } from '../../../src/order.js';

const FILE = '/tmp/opencode/order-store-test.json';

function sampleOrder(clientOrderId: string, status: Order['status']): Order {
  const now = Date.now();
  return {
    clientOrderId,
    exchangeOrderId: status === 'CREATED' ? null : 'e1',
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    status,
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: now,
    updatedAtMs: now,
  };
}

describe('OrderStore — durable order ledger keyed by clientOrderId', () => {
  it('returns null when no ledger exists yet', () => {
    rmSync(FILE, { force: true });
    const store = new OrderStore(FILE);
    expect(store.load()).toBeNull();
    expect(store.allOrders().size).toBe(0);
  });

  it('round-trips orders and is keyed by clientOrderId', () => {
    rmSync(FILE, { force: true });
    const store = new OrderStore(FILE);
    store.save(sampleOrder('a', 'CREATED'));
    store.save(sampleOrder('b', 'FILLED'));

    const reloaded = new OrderStore(FILE);
    expect(reloaded.get('a')!.status).toBe('CREATED');
    expect(reloaded.get('b')!.status).toBe('FILLED');
    expect(reloaded.get('missing')).toBeNull();
  });

  it('upserts by clientOrderId (no duplicates)', () => {
    rmSync(FILE, { force: true });
    const store = new OrderStore(FILE);
    store.save(sampleOrder('a', 'CREATED'));
    store.save(sampleOrder('a', 'FILLED'));
    expect(store.allOrders().size).toBe(1);
    expect(store.get('a')!.status).toBe('FILLED');
  });

  it('lists open local orders as non-terminal states', () => {
    rmSync(FILE, { force: true });
    const store = new OrderStore(FILE);
    store.save(sampleOrder('open', 'OPEN'));
    store.save(sampleOrder('partial', 'PARTIALLY_FILLED'));
    store.save(sampleOrder('submitted', 'SUBMITTED'));
    store.save(sampleOrder('unknown', 'UNKNOWN'));
    store.save(sampleOrder('filled', 'FILLED'));
    const open = store.openLocalOrders().map((o) => o.clientOrderId);
    expect(open.sort()).toEqual(['open', 'partial', 'submitted', 'unknown']);
  });

  it('recovers after a simulated restart (duplicate-prevention test)', () => {
    rmSync(FILE, { force: true });
    const first = new OrderStore(FILE);
    first.save(sampleOrder('critical', 'CREATED'));
    // "crash" — a fresh store instance reading the same file sees the claim.
    const second = new OrderStore(FILE);
    expect(second.get('critical')).not.toBeNull();
    // Re-submitting the same clientOrderId is detectable as a duplicate.
    expect(second.get('critical')!.status).toBe('CREATED');
  });
});
