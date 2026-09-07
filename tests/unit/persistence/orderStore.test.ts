import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import type { Order } from '../../../src/order.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'retrac-order-')), 'ledger.json');
}

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
  it('reports MISSING when no ledger exists yet', () => {
    const store = new OrderStore(freshFile());
    expect(store.load().status).toBe('MISSING');
    expect(store.allOrders().size).toBe(0);
  });

  it('round-trips orders and is keyed by clientOrderId', () => {
    const path = freshFile();
    const store = new OrderStore(path);
    store.save(sampleOrder('a', 'CREATED'));
    store.save(sampleOrder('b', 'FILLED'));

    const reloaded = new OrderStore(path);
    expect(reloaded.get('a')!.status).toBe('CREATED');
    expect(reloaded.get('b')!.status).toBe('FILLED');
    expect(reloaded.get('missing')).toBeNull();
  });

  it('upserts by clientOrderId (no duplicates)', () => {
    const store = new OrderStore(freshFile());
    store.save(sampleOrder('a', 'CREATED'));
    store.save(sampleOrder('a', 'FILLED'));
    expect(store.allOrders().size).toBe(1);
    expect(store.get('a')!.status).toBe('FILLED');
  });

  it('lists open local orders as non-terminal states', () => {
    const store = new OrderStore(freshFile());
    store.save(sampleOrder('open', 'OPEN'));
    store.save(sampleOrder('partial', 'PARTIALLY_FILLED'));
    store.save(sampleOrder('submitted', 'SUBMITTED'));
    store.save(sampleOrder('unknown', 'UNKNOWN'));
    store.save(sampleOrder('filled', 'FILLED'));
    const open = store.openLocalOrders().map((o) => o.clientOrderId);
    expect(open.sort()).toEqual(['open', 'partial', 'submitted', 'unknown']);
  });

  it('recovers after a simulated restart (duplicate-prevention test)', () => {
    const path = freshFile();
    const first = new OrderStore(path);
    first.save(sampleOrder('critical', 'CREATED'));
    const second = new OrderStore(path);
    expect(second.get('critical')).not.toBeNull();
    expect(second.get('critical')!.status).toBe('CREATED');
  });

  it('a corrupt ledger is CORRUPT and save() refuses to overwrite it', () => {
    const path = freshFile();
    rmSync(path, { force: true });
    writeFileSync(path, '{ not json');
    const store = new OrderStore(path);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.save(sampleOrder('a', 'CREATED'))).toThrow(/refusing to overwrite/);
  });
});
