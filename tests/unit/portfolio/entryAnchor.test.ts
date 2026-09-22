import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';

const SYMBOL = 'BTC/CAD';

const A = Money.fromString('111');
const B = Money.fromString('222');

function seed(cad = '100000'): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cad)]]));
}

function buy(p: Portfolio, qty: string, price: string, anchor?: Money): Portfolio {
  return p.applyFill(SYMBOL, 'BUY', Money.fromString(qty), Money.fromString(price), Money.zero(), undefined, anchor);
}

describe('Portfolio entry anchor', () => {
  it('BUY while flat freezes the anchor onto the new position', () => {
    const p = buy(seed(), '0.1', '100', A);
    expect(p.position(SYMBOL)!.entryAnchorPrice!.equals(A)).toBe(true);
  });

  it('BUY while flat without an anchor stores null', () => {
    const p = buy(seed(), '0.1', '100');
    expect(p.position(SYMBOL)!.entryAnchorPrice).toBeNull();
  });

  it('rejects a zero entry anchor fail-closed and creates no position state', () => {
    const base = seed();
    expect(() => buy(base, '0.1', '100', Money.zero())).toThrow(/entry anchor/);
    // The rejecting call mutated nothing: no position, no cash movement.
    expect(base.position(SYMBOL)).toBeNull();
    expect(base.cash('CAD').equals(Money.fromString('100000'))).toBe(true);
  });

  it('rejects a negative entry anchor fail-closed and creates no position state', () => {
    const base = seed();
    expect(() => buy(base, '0.1', '100', Money.fromString('-1'))).toThrow(/entry anchor/);
    expect(base.position(SYMBOL)).toBeNull();
  });

  it('BUY while already long never overwrites an existing anchor', () => {
    let p = buy(seed(), '0.1', '100', A);
    p = buy(p, '0.1', '200', B);
    expect(p.position(SYMBOL)!.entryAnchorPrice!.equals(A)).toBe(true);
  });

  it('BUY while already long preserves a null anchor (never adopts a new one)', () => {
    // INTENTIONAL: an already-open position with no anchor (e.g. an
    // external/manual position) stays anchor-less on a scale-in. Existing
    // anchors are never overwritten and this change does not seed anchors onto
    // already-open positions (TPR does not pyramid/scale in).
    let p = buy(seed(), '0.1', '100');
    p = buy(p, '0.1', '200', B);
    expect(p.position(SYMBOL)!.entryAnchorPrice).toBeNull();
  });

  it('partial SELL preserves the anchor', () => {
    let p = buy(seed(), '0.2', '100', A);
    p = p.applyFill(SYMBOL, 'SELL', Money.fromString('0.1'), Money.fromString('150'), Money.zero());
    expect(p.position(SYMBOL)!.entryAnchorPrice!.equals(A)).toBe(true);
    expect(p.position(SYMBOL)!.quantity.equals(Money.fromString('0.1'))).toBe(true);
  });

  it('full SELL removes the position entirely', () => {
    let p = buy(seed(), '0.2', '100', A);
    p = p.applyFill(SYMBOL, 'SELL', Money.fromString('0.2'), Money.fromString('150'), Money.zero());
    expect(p.position(SYMBOL)).toBeNull();
  });

  it('re-entry after flat can establish a fresh anchor', () => {
    let p = buy(seed(), '0.2', '100', A);
    p = p.applyFill(SYMBOL, 'SELL', Money.fromString('0.2'), Money.fromString('150'), Money.zero());
    p = buy(p, '0.1', '300', B);
    expect(p.position(SYMBOL)!.entryAnchorPrice!.equals(B)).toBe(true);
  });

  it('a re-entry without an anchor does not resurrect the previous anchor', () => {
    let p = buy(seed(), '0.2', '100', A);
    p = p.applyFill(SYMBOL, 'SELL', Money.fromString('0.2'), Money.fromString('150'), Money.zero());
    p = buy(p, '0.1', '300');
    expect(p.position(SYMBOL)!.entryAnchorPrice).toBeNull();
  });

  it('ignores the anchor on SELL', () => {
    let p = buy(seed(), '0.2', '100', A);
    p = p.applyFill(SYMBOL, 'SELL', Money.fromString('0.1'), Money.fromString('150'), Money.zero(), undefined, B);
    expect(p.position(SYMBOL)!.entryAnchorPrice!.equals(A)).toBe(true);
  });
});
