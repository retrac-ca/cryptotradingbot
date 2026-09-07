/**
 * Gate 7.1 — order-linked reservation lifecycle (Portfolio).
 *
 * These tests cover the association between a logical order and its quote
 * reservation, the per-order `remaining` amount, partial-consumption
 * representability, exactly-once release, cross-order isolation, deployable
 * bounding, persistence, and fail-closed reconstruction of legacy/empty state.
 *
 * NOTE (documented limitation): a reservation means "funds are unavailable for
 * other orders", NOT "the exchange has filled the order". This gate provides the
 * reservation bookkeeping primitives only. The consumed portion is kept in the
 * aggregate `reserved` pool (conservative) and is paired with a cash reduction
 * (`applyFill`) by Gate 7.2; it never inflates `deployableQuote`.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio, PortfolioJsonV2 } from '../../../src/portfolio/serialization.js';

function p(cash: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
}

describe('Gate 7.1 — order-linked reservations', () => {
  it('links a reservation to exactly one logical order and bounds deployable', () => {
    const r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('300'));
    const res = r.orderReservation('order-A')!;
    expect(res.orderId).toBe('order-A');
    expect(res.currency).toBe('CAD');
    expect(res.amount.toString()).toBe('300.00000000');
    expect(res.remaining.toString()).toBe('300.00000000');
    expect(res.status).toBe('ACTIVE');
    expect(r.reserved('CAD').toString()).toBe('300.00000000');
    expect(r.deployableQuote('CAD').toString()).toBe('700.00000000');
  });

  it('a logical order cannot acquire two independent reservations', () => {
    const r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('300'));
    expect(() => r.reserveOrder('order-A', 'CAD', Money.fromString('200'))).toThrow(/already has a reservation/);
  });

  it('a reservation cannot exceed deployable quote (exact boundary succeeds, one unit over fails)', () => {
    const exact = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('1000'));
    expect(exact.reserved('CAD').toString()).toBe('1000.00000000');
    expect(exact.deployableQuote('CAD').isZero()).toBe(true);
    expect(() => p('1000').reserveOrder('order-B', 'CAD', Money.fromString('1000.00000001'))).toThrow(/exceeds deployable quote/);
    expect(() => p('1000').reserveOrder('order-C', 'CAD', Money.fromString('1500'))).toThrow(/exceeds deployable quote/);
  });

  it('rejects a non-positive reservation amount and a throwing call leaves state intact', () => {
    const r = p('1000');
    expect(() => r.reserveOrder('order-A', 'CAD', Money.zero())).toThrow(/must be positive/);
    expect(() => r.reserveOrder('order-A', 'CAD', Money.fromString('-5'))).toThrow(/must be positive/);
    expect(r.reserved('CAD').isZero()).toBe(true);
    expect(r.orderReservationsView().size).toBe(0);
  });

  it('partial consumption tracks remaining and cannot exceed it', () => {
    let r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('1000'));
    r = r.consumeOrderReservation('order-A', Money.fromString('400'));
    expect(r.orderReservation('order-A')!.remaining.toString()).toBe('600.00000000');
    r = r.consumeOrderReservation('order-A', Money.fromString('300'));
    expect(r.orderReservation('order-A')!.remaining.toString()).toBe('300.00000000');
    expect(() => r.consumeOrderReservation('order-A', Money.fromString('300.00000001'))).toThrow(/exceeds remaining/);
    expect(() => r.consumeOrderReservation('order-A', Money.zero())).toThrow(/must be positive/);
    expect(() => r.consumeOrderReservation('order-A', Money.fromString('-1'))).toThrow(/must be positive/);
  });

  it('consuming is conservative: it does not inflate deployable quote', () => {
    let r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('1000'));
    r = r.consumeOrderReservation('order-A', Money.fromString('400'));
    // consumed(400) stays committed; reserved unchanged; deployable stays 0.
    expect(r.reserved('CAD').toString()).toBe('1000.00000000');
    expect(r.deployableQuote('CAD').isZero()).toBe(true);
  });

  it('terminal release frees only the remaining; double release is a safe no-op', () => {
    let r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('1000'));
    r = r.consumeOrderReservation('order-A', Money.fromString('400'));
    // reserved before release: 1000 (consumed 400 still committed + remaining 600).
    r = r.releaseOrderReservation('order-A');
    expect(r.orderReservation('order-A')!.status).toBe('RELEASED');
    expect(r.orderReservation('order-A')!.remaining.isZero()).toBe(true);
    // released the remaining 600 -> reserved drops to committed consumed (400).
    expect(r.reserved('CAD').toString()).toBe('400.00000000');
    expect(r.deployableQuote('CAD').toString()).toBe('600.00000000');
    // double release is a no-op, never negative.
    const after = r.releaseOrderReservation('order-A');
    expect(after.reserved('CAD').toString()).toBe('400.00000000');
    expect(after.reserved('CAD').isNegative()).toBe(false);
  });

  it('cannot release another order\u2019s reservation, and reservations are independent', () => {
    let r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('300'));
    r = r.reserveOrder('order-B', 'CAD', Money.fromString('200'));
    expect(r.reserved('CAD').toString()).toBe('500.00000000');
    r = r.consumeOrderReservation('order-A', Money.fromString('100')); // A remaining 200
    r = r.consumeOrderReservation('order-B', Money.fromString('50')); // B remaining 150
    // releasing A must not consume B.
    r = r.releaseOrderReservation('order-A');
    expect(r.orderReservation('order-A')!.status).toBe('RELEASED');
    expect(r.orderReservation('order-B')!.remaining.toString()).toBe('150.00000000');
    expect(r.orderReservation('order-B')!.status).toBe('ACTIVE');
    // B can still be consumed against its own remaining.
    r = r.consumeOrderReservation('order-B', Money.fromString('100'));
    expect(r.orderReservation('order-B')!.remaining.toString()).toBe('50.00000000');
    // releasing an unknown order id is a no-op.
    const after = r.releaseOrderReservation('order-unknown');
    expect(after.reserved('CAD').toString()).toBe(r.reserved('CAD').toString());
  });

  it('consuming/releasing a non-existent or already-released order fails closed / no-ops safely', () => {
    const r = p('1000');
    expect(() => r.consumeOrderReservation('order-X', Money.fromString('10'))).toThrow(/no active reservation/);
    // releasing an unknown order is a safe no-op.
    expect(r.releaseOrderReservation('order-X')).toBe(r);
    let q = r.reserveOrder('order-A', 'CAD', Money.fromString('300'));
    q = q.releaseOrderReservation('order-A');
    expect(() => q.consumeOrderReservation('order-A', Money.fromString('10'))).toThrow(/no active reservation/);
  });

  it('order + reservation survive serialize/deserialize exactly (restart preservation)', () => {
    let r = p('1000').reserveOrder('order-A', 'CAD', Money.fromString('500'));
    r = r.consumeOrderReservation('order-A', Money.fromString('150'));
    const doc = serializePortfolio(r.stateModel);
    expect(doc.orderReservations?.['order-A']?.amount).toBe('500.00000000');
    expect(doc.orderReservations?.['order-A']?.remaining).toBe('350.00000000');
    expect(doc.orderReservations?.['order-A']?.status).toBe('ACTIVE');
    const restored = Portfolio.fromModel(deserializePortfolio(doc));
    const res = restored.orderReservation('order-A')!;
    expect(res.orderId).toBe('order-A');
    expect(res.currency).toBe('CAD');
    expect(res.amount.toString()).toBe('500.00000000');
    expect(res.remaining.toString()).toBe('350.00000000');
    expect(res.status).toBe('ACTIVE');
    expect(restored.reserved('CAD').toString()).toBe('500.00000000'); // consumed(150) still committed
  });

  it('two simultaneous logical orders have fully independent reservations', () => {
    const r0: Portfolio = p('1000');
    // two different logical orders, same intended funds pool.
    const r = r0.reserveOrder('order-A', 'CAD', Money.fromString('300')).reserveOrder('order-B', 'CAD', Money.fromString('200'));
    expect(r.reserved('CAD').toString()).toBe('500.00000000');
    expect(r.orderReservation('order-A')!.remaining.toString()).toBe('300.00000000');
    expect(r.orderReservation('order-B')!.remaining.toString()).toBe('200.00000000');
    expect(r.deployableQuote('CAD').toString()).toBe('500.00000000');
    const afterA = r.consumeOrderReservation('order-A', Money.fromString('300'));
    expect(afterA.orderReservation('order-A')!.remaining.isZero()).toBe(true);
    expect(afterA.orderReservation('order-B')!.remaining.toString()).toBe('200.00000000');
  });

  it('legacy/empty state (no orderReservations field) loads with empty order reservations', () => {
    const legacy: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000.00000000' },
      positions: {},
      peakEquity: '1000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
      reserved: { CAD: '300.00000000' },
    };
    const restored = Portfolio.fromModel(deserializePortfolio(legacy));
    // The fungible reserved survives (still bounds deployable) but there is no
    // order linkage to invent.
    expect(restored.reserved('CAD').toString()).toBe('300.00000000');
    expect(restored.deployableQuote('CAD').toString()).toBe('700.00000000');
    expect(restored.orderReservationsView().size).toBe(0);
  });

  it('corrupt persisted reservation state fails closed on load', () => {
    const badRemaining: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000.00000000' },
      positions: {},
      peakEquity: '1000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
      orderReservations: {
        'order-A': { orderId: 'order-A', currency: 'CAD', amount: '500.00000000', remaining: '600.00000000', status: 'ACTIVE' },
      },
    };
    expect(() => deserializePortfolio(badRemaining)).toThrow(/exceeds amount/);

    const badReleased: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000.00000000' },
      positions: {},
      peakEquity: '1000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
      orderReservations: {
        'order-A': { orderId: 'order-A', currency: 'CAD', amount: '500.00000000', remaining: '100.00000000', status: 'RELEASED' },
      },
    };
    expect(() => deserializePortfolio(badReleased)).toThrow(/RELEASED/);
  });
});
