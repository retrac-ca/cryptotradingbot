/**
 * Gate 7.2 — idempotent live fill/execution → Portfolio accounting.
 *
 * The invariant under test: one exchange execution may mutate Portfolio
 * accounting at most once, keyed by an IDENTITY (execution/fill id) — never by
 * order id, order status, or symbol+qty+price+timestamp. The identity is
 * exchange-provided (or operator-asserted); a live fill WITHOUT a trustworthy
 * identity is refused (fail closed). Duplicate observations must be no-ops and
 * a conflicting observation (same identity, different payload) must fail closed.
 *
 * Gate 7.2 provides the idempotent accounting PRIMITIVE + durable applied-state.
 * It does NOT yet make reconciliation trust exchange fills (NDAX currently
 * supplies no execution id) — that is Gate 7.3.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';
import type { Fill } from '../../../src/order.js';
import type { PortfolioJsonV1 } from '../../../src/portfolio/serialization.js';

function portfolio(cash: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
}

function fill(execId: string, qty: string, price: string, fee: string): Fill {
  return {
    price: Money.fromString(price),
    quantity: Money.fromString(qty),
    fee: Money.fromString(fee),
    feeCurrency: 'quote',
    timestampMs: null,
    executionId: execId,
  };
}

describe('Gate 7.2 — idempotent live fill accounting', () => {
  it('one identified BUY fill applies exactly once', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000');
    expect(p.cash('CAD').toString()).toBe('895.00000000'); // 1000 - (1*100 + 5)
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('395.00000000'); // 500 - 105
    expect(p.reserved('CAD').toString()).toBe('395.00000000'); // paired reserved reduction
    expect(p.appliedCount()).toBe(1);
  });

  it('same BUY fill observed twice applies only once (no double mutation)', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    const after = p;
    const p2 = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    expect(p2).toBe(p); // idempotent no-op returns same instance
    expect(p2.appliedCount()).toBe(1);
    expect(p2.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000');
    expect(p2.cash('CAD').toString()).toBe('895.00000000');
    expect(after.cash('CAD').toString()).toBe('895.00000000'); // = p2 (identical)
  });

  it('same BUY fill after a persistence reload applies only once (restart-safe)', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    const again = restored.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    expect(again).toBe(restored);
    expect(again.appliedCount()).toBe(1);
    expect(again.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000');
    expect(again.cash('CAD').toString()).toBe('895.00000000');
  });

  it('two distinct partial BUY fills both apply once (0.3 + 0.2 + 0.5 = 1.0)', () => {
    let p = portfolio('200000').reserveOrder('o1', 'CAD', Money.fromString('200000'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('A', '0.3', '100000', '100'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.30000000');
    expect(p.cash('CAD').toString()).toBe('169900.00000000'); // 200000 - 30100
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('169900.00000000');
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.50000000');
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('C', '0.5', '100000', '150'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000'); // 0.3+0.2+0.5, NOT 1.2
    expect(p.cash('CAD').toString()).toBe('99700.00000000'); // 200000 - 100300
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('99700.00000000');
    expect(p.appliedCount()).toBe(3);
  });

  it('a duplicate partial fill does not double-count', () => {
    let p = portfolio('200000').reserveOrder('o1', 'CAD', Money.fromString('200000'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('A', '0.3', '100000', '100'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('C', '0.5', '100000', '150'));
    // duplicate B -> no-op
    const after = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    expect(after.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000'); // not 1.2
    expect(after.cash('CAD').toString()).toBe('99700.00000000'); // not double debited
    expect(after.orderReservation('o1')!.remaining.toString()).toBe('99700.00000000');
    expect(after.appliedCount()).toBe(3);
  });

  it('terminal remaining reservation releases exactly once', () => {
    let p = portfolio('200000').reserveOrder('o1', 'CAD', Money.fromString('200000'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('A', '0.3', '100000', '100'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('C', '0.5', '100000', '150'));
    p = p.releaseOrderReservation('o1');
    expect(p.orderReservation('o1')!.status).toBe('RELEASED');
    expect(p.orderReservation('o1')!.remaining.isZero()).toBe(true);
    expect(p.reserved('CAD').isZero()).toBe(true); // released the remaining 99700
    // double release is a safe no-op and never goes negative.
    const again = p.releaseOrderReservation('o1');
    expect(again.reserved('CAD').isZero()).toBe(true);
  });

  it('one identified SELL fill applies once; duplicate does not double-count', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('b1', '1', '100', '5'));
    p = p.applyLiveFill('o-sell', 'BTC/CAD', 'SELL', fill('s1', '0.5', '120', '3'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.50000000');
    expect(p.cash('CAD').toString()).toBe('952.00000000'); // 895 + (0.5*120 - 3)
    expect(p.appliedCount()).toBe(2);
    const dup = p.applyLiveFill('o-sell', 'BTC/CAD', 'SELL', fill('s1', '0.5', '120', '3'));
    expect(dup).toBe(p);
    expect(dup.position('BTC/CAD')!.quantity.toString()).toBe('0.50000000');
    expect(dup.cash('CAD').toString()).toBe('952.00000000');
    expect(dup.appliedCount()).toBe(2);
  });

  it('BOT/EXTERNAL_AUTHORIZED provenance remains BOT-first under live SELL fills', () => {
    let p = portfolio('1000')
      .withExternalSnapshot(new Map([['BTC/CAD', Money.fromString('0.5')]]))
      .authorizeExternal('BTC/CAD');
    p = p.reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('b1', '0.5', '100', '0'));
    // position now 1.0 = BOT 0.5 + EXTERNAL_AUTHORIZED 0.5
    expect(p.position('BTC/CAD')!.sourceQuantities.BOT.toString()).toBe('0.50000000');
    expect(p.position('BTC/CAD')!.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe('0.50000000');
    // selling 0.5 must consume BOT FIRST (Gate 5 semantics).
    p = p.applyLiveFill('o-sell', 'BTC/CAD', 'SELL', fill('s1', '0.5', '100', '0'));
    const pos = p.position('BTC/CAD')!;
    expect(pos.quantity.toString()).toBe('0.50000000');
    expect(pos.sourceQuantities.BOT.toString()).toBe('0.00000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe('0.50000000');
  });

  it('a conflicting payload under the same execution ID fails closed (no mutation)', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    expect(() =>
      p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '2', '100', '5')),
    ).toThrow(/conflict|different|mismatch/);
    // no mutation occurred.
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000');
    expect(p.cash('CAD').toString()).toBe('895.00000000');
    expect(p.appliedCount()).toBe(1);
  });

  it('an execution applied to a different order conflicts and fails closed', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    expect(() =>
      p.applyLiveFill('o-other', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5')),
    ).toThrow(/already applied to order/);
  });

  it('two distinct execution IDs with identical economic values are both accepted', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '0.2', '100', '1'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f2', '0.2', '100', '1'));
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.40000000'); // both accepted
    expect(p.appliedCount()).toBe(2);
    // cost each = 0.2*100 + 1 = 21 -> cash = 1000 - 42 = 958.
    expect(p.cash('CAD').toString()).toBe('958.00000000');
  });

  it('a fill without a trustworthy execution identity fails closed (does not apply)', () => {
    const p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    const noId: Fill = { price: Money.fromString('100'), quantity: Money.fromString('1'), fee: Money.fromString('5'), feeCurrency: 'quote', timestampMs: null };
    expect(() => p.applyLiveFill('o1', 'BTC/CAD', 'BUY', noId)).toThrow(/no executionId|without a trustworthy identity/);
    // nothing was applied.
    expect(p.appliedCount()).toBe(0);
    expect(p.position('BTC/CAD')).toBeNull();
    expect(p.cash('CAD').toString()).toBe('1000.00000000');
  });

  it('persistence preserves applied execution identities (survives reload)', () => {
    let p = portfolio('1000').reserveOrder('o1', 'CAD', Money.fromString('500'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('f1', '1', '100', '5'));
    const doc = serializePortfolio(p.stateModel);
    expect(doc.appliedExecutions?.['f1']?.orderId).toBe('o1');
    expect(doc.appliedExecutions?.['f1']?.quantity).toBe('1.00000000');
    const restored = Portfolio.fromModel(deserializePortfolio(doc));
    expect(restored.appliedExecution('f1')).not.toBeNull();
    expect(restored.appliedExecution('f1')!.quantity.toString()).toBe('1.00000000');
    expect(restored.appliedCount()).toBe(1);
  });

  it('restart scenario with partial fills preserves exactly-once behaviour', () => {
    let p = portfolio('200000').reserveOrder('o1', 'CAD', Money.fromString('200000'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('A', '0.3', '100000', '100'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('C', '0.5', '100000', '150'));
    // simulate restart
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    const afterA = restored.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('A', '0.3', '100000', '100'));
    expect(afterA.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000'); // A not re-applied
    const afterB = afterA.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill('B', '0.2', '100000', '50'));
    expect(afterB.position('BTC/CAD')!.quantity.toString()).toBe('1.00000000'); // B not re-applied
    expect(afterB.cash('CAD').toString()).toBe('99700.00000000');
    expect(afterB.appliedCount()).toBe(3);
  });

  it('legacy/empty state loads with empty applied executions (nothing invented)', () => {
    const legacy: PortfolioJsonV1 = {
      version: 1,
      cash: { CAD: '1000.00000000' },
      positions: {},
      peakEquity: '1000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
    };
    const restored = Portfolio.fromModel(deserializePortfolio(legacy));
    expect(restored.appliedCount()).toBe(0);
  });
});
