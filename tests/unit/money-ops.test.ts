import { describe, expect, it } from 'vitest';
import { Money } from '../../src/money/Money.js';

describe('Money mul / div / floorToIncrement', () => {
  it('multiplies two same-scale values to a same-scale result', () => {
    const a = Money.fromString('2.5');
    const b = Money.fromString('4');
    expect(a.mul(b).toString()).toBe('10.00000000');
  });

  it('multiplies with rounding', () => {
    const a = Money.fromString('1.000000001');
    const b = Money.fromString('1');
    // product scaled to 8 decimals rounds half-up: 1.000000001 -> 1.00000000
    expect(a.mul(b).toString()).toBe('1.00000000');
  });

  it('multiplies negatives correctly', () => {
    const a = Money.fromString('-2.5');
    const b = Money.fromString('4');
    expect(a.mul(b).toString()).toBe('-10.00000000');
    expect(a.mul(b.negate()).toString()).toBe('10.00000000');
  });

  it('divides notional by price to get quantity', () => {
    const notional = Money.fromString('100.00');
    const price = Money.fromString('40000.00');
    const qty = notional.div(price);
    expect(qty.toFixed(8)).toBe('0.00250000');
  });

  it('throws on division by zero', () => {
    expect(() => Money.fromString('5').div(Money.zero())).toThrow(/zero/);
  });

  it('floors to a multiple (rounds down)', () => {
    const inc = Money.fromString('0.001');
    expect(Money.fromString('0.0125').floorToIncrement(inc).toString()).toBe('0.01200000');
    expect(Money.fromString('0.001').floorToIncrement(inc).toString()).toBe('0.00100000');
    expect(Money.fromString('0.0005').floorToIncrement(inc).toString()).toBe('0.00000000');
  });

  it('floorToIncrement never exceeds the input magnitude', () => {
    const inc = Money.fromString('0.01');
    const v = Money.fromString('0.099');
    expect(v.floorToIncrement(inc).compareTo(v)).toBeLessThanOrEqual(0);
  });

  it('roundToIncrement still rounds half-up as documented', () => {
    const inc = Money.fromString('0.01');
    expect(Money.fromString('0.015').roundToIncrement(inc).toString()).toBe('0.02000000');
  });
});
