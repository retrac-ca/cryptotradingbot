import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Reconciler, TERMINAL } from '../../../src/reconcile/Reconciler.js';
import type { ExchangeAccountSnapshot, LocalOrderLedger } from '../../../src/reconcile/types.js';
import type { Order } from '../../../src/order.js';

function order(partial: Partial<Order> & { clientOrderId: string }): Order {
  return {
    exchangeOrderId: null,
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    status: 'OPEN',
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...partial,
  };
}

const now = Date.now();
const emptySnapshot = (): ExchangeAccountSnapshot => ({
  balances: [{ currency: 'CAD', total: Money.fromString('10000'), available: Money.fromString('10000'), held: Money.zero() }],
  openOrders: [],
  orderHistory: [],
  fetchedAtMs: now,
});

function local(orders: Order[]): LocalOrderLedger {
  const map = new Map(orders.map((o) => [o.clientOrderId, o]));
  const openIds = orders.filter((o) => !TERMINAL.has(o.status)).map((o) => o.clientOrderId);
  return { orders: map, openLocalOrderIds: openIds };
}

describe('Reconciler — local intent vs exchange authoritative state', () => {
  it('is consistent and safe when local open orders all appear on the exchange', () => {
    const localOrder = order({ clientOrderId: 'a', exchangeOrderId: '10' });
    const snapshot: ExchangeAccountSnapshot = {
      ...emptySnapshot(),
      openOrders: [localOrder],
      orderHistory: [localOrder],
    };
    const report = new Reconciler().reconcile(local([localOrder]), snapshot);
    expect(report.consistent).toBe(true);
    expect(report.safeToTrade).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('fails safe when a local open order is missing on the exchange', () => {
    const localOrder = order({ clientOrderId: 'a', exchangeOrderId: '10' });
    const report = new Reconciler().reconcile(local([localOrder]), emptySnapshot());
    expect(report.consistent).toBe(false);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'LOCAL_OPEN_MISSING_ON_EXCHANGE', clientOrderId: 'a' }),
    );
  });

  it('fails safe when the exchange cannot be read (fail closed)', () => {
    const localOrder = order({ clientOrderId: 'a', exchangeOrderId: '10' });
    const snapshot = emptySnapshot();
    snapshot.balances = undefined as never; // treat as missing/incomplete
    const report = new Reconciler().reconcile(local([localOrder]), snapshot);
    expect(report.consistent).toBe(false);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies[0]!.kind).toBe('CANNOT_DETERMINE');
  });

  it('flags an unknown open order on the exchange that the bot did not create', () => {
    const foreign = order({ clientOrderId: 'zzz', exchangeOrderId: '77' });
    const snapshot: ExchangeAccountSnapshot = {
      ...emptySnapshot(),
      openOrders: [foreign],
      orderHistory: [foreign],
    };
    const report = new Reconciler().reconcile(local([]), snapshot);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'EXCHANGE_ORDER_UNKNOWN_LOCALLY', clientOrderId: 'zzz' }),
    );
  });

  it('flags a terminal-status mismatch between local and exchange', () => {
    const localOrder = order({ clientOrderId: 'a', exchangeOrderId: '10', status: 'OPEN' });
    const exchFilled = order({ clientOrderId: 'a', exchangeOrderId: '10', status: 'FILLED' });
    const snapshot: ExchangeAccountSnapshot = {
      ...emptySnapshot(),
      openOrders: [],
      orderHistory: [exchFilled],
    };
    const report = new Reconciler().reconcile(local([localOrder]), snapshot);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'LOCAL_ORDER_STATUS_MISMATCH' }),
    );
  });

  it('flags a negative balance', () => {
    const snapshot: ExchangeAccountSnapshot = {
      ...emptySnapshot(),
      balances: [{ currency: 'BTC', total: Money.fromString('-0.5'), available: Money.fromString('-0.5'), held: Money.zero() }],
    };
    const report = new Reconciler().reconcile(local([]), snapshot);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'BALANCE_NEGATIVE', currency: 'BTC' }),
    );
  });

  // ---- Item 2: local-vs-exchange balance reconciliation (expectedBalances) ----

  it('is consistent and safe when expected local balances match exchange balances', () => {
    const snapshot = emptySnapshot(); // CAD available = 10000
    const report = new Reconciler().reconcile(local([]), snapshot, {
      expectedBalances: new Map([['CAD', Money.fromString('10000')]]),
    });
    expect(report.consistent).toBe(true);
    expect(report.safeToTrade).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('treats a difference within balanceTolerance as a match (not a discrepancy)', () => {
    const snapshot = emptySnapshot(); // CAD available = 10000
    const report = new Reconciler().reconcile(local([]), snapshot, {
      expectedBalances: new Map([['CAD', Money.fromString('10000.00000001')]]),
      // tolerance of 0.00000002 absorbs the one-unit difference
      balanceTolerance: Money.fromString('0.00000002'),
    });
    expect(report.safeToTrade).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('flags an unexplained balance mismatch and fails safe (safeToTrade=false)', () => {
    const snapshot = emptySnapshot(); // CAD available = 10000
    const report = new Reconciler().reconcile(local([]), snapshot, {
      expectedBalances: new Map([['CAD', Money.fromString('9000')]]),
    });
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'BALANCE_MISMATCH', currency: 'CAD' }),
    );
    // The local balance must NOT be silently overwritten: it is surfaced, not fixed.
    expect(report.discrepancies[0]!.detail).toContain('CAD');
  });

  it('fails safe when the exchange reports no balance for an expected currency', () => {
    const snapshot = emptySnapshot(); // only CAD present
    const report = new Reconciler().reconcile(local([]), snapshot, {
      expectedBalances: new Map([['BTC', Money.fromString('0.5')]]),
    });
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies).toContainEqual(
      expect.objectContaining({ kind: 'BALANCE_MISMATCH', currency: 'BTC' }),
    );
  });

  it('ignores exchange currencies the bot does not expect (not a discrepancy)', () => {
    const snapshot: ExchangeAccountSnapshot = {
      ...emptySnapshot(),
      balances: [
        { currency: 'CAD', total: Money.fromString('10000'), available: Money.fromString('10000'), held: Money.zero() },
        { currency: 'ETH', total: Money.fromString('2'), available: Money.fromString('2'), held: Money.zero() },
      ],
    };
    // Bot only expects CAD; ETH on the exchange is simply untracked by the bot.
    const report = new Reconciler().reconcile(local([]), snapshot, {
      expectedBalances: new Map([['CAD', Money.fromString('10000')]]),
    });
    expect(report.consistent).toBe(true);
    expect(report.safeToTrade).toBe(true);
  });
});
