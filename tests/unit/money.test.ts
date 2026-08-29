import { describe, expect, it } from 'vitest';
import { Money } from '../../src/money/Money.js';

describe('Money', () => {
  describe('construction', () => {
    it('parses decimal strings exactly', () => {
      expect(Money.fromString('0.1').toFixed(1)).toBe('0.1');
      expect(Money.fromString('1234.5678').toFixed(4)).toBe('1234.5678');
    });

    it('parses without fractional part', () => {
      expect(Money.fromString('5').toFixed(2)).toBe('5.00');
    });

    it('handles negative values', () => {
      expect(Money.fromString('-0.25').toFixed(2)).toBe('-0.25');
    });

    it('handles leading/trailing whitespace', () => {
      expect(Money.fromString('  1.5  ').toFixed(2)).toBe('1.50');
    });

    it('rejects invalid input', () => {
      expect(() => Money.fromString('')).toThrow();
      expect(() => Money.fromString('abc')).toThrow();
      expect(() => Money.fromString('1.2.3')).toThrow();
      expect(() => Money.fromString('--5')).toThrow();
    });

    it('rounds half-up beyond supported scale (8 decimals)', () => {
      expect(Money.fromString('1.000000001').toFixed(8)).toBe('1.00000000');
      expect(Money.fromString('1.000000005').toFixed(8)).toBe('1.00000001');
    });
  });

  describe('arithmetic', () => {
    it('adds without floating point error', () => {
      const sum = Money.fromString('0.1').add(Money.fromString('0.2'));
      expect(sum.toFixed(1)).toBe('0.3');
    });

    it('subtracts exactly', () => {
      const diff = Money.fromString('1.00').sub(Money.fromString('0.30'));
      expect(diff.toFixed(2)).toBe('0.70');
    });

    it('negates', () => {
      expect(Money.fromString('1.5').negate().toFixed(1)).toBe('-1.5');
    });
  });

  describe('fraction multiplication (sizing without floats)', () => {
    it('multiplies by an exact fraction', () => {
      const result = Money.fromString('100.00').mulFraction(1n, 4n);
      expect(result.toFixed(2)).toBe('25.00');
    });

    it('computes percentage of balance', () => {
      const balance = Money.fromString('10000.00');
      const tenPercent = balance.mulFraction(10n, 100n);
      expect(tenPercent.toFixed(2)).toBe('1000.00');
      const third = balance.mulFraction(1n, 3n);
      expect(third.toFixed(2)).toBe('3333.33');
    });

    it('rejects zero denominator', () => {
      expect(() => Money.fromString('1').mulFraction(1n, 0n)).toThrow();
    });
  });

  describe('comparison', () => {
    it('compares values', () => {
      const a = Money.fromString('0.3');
      const b = Money.fromString('0.1').add(Money.fromString('0.2'));
      expect(a.equals(b)).toBe(true);
      expect(a.compareTo(b)).toBe(0);
      expect(Money.fromString('1').compareTo(Money.fromString('2'))).toBe(-1);
      expect(Money.fromString('2').compareTo(Money.fromString('1'))).toBe(1);
    });

    it('reports sign', () => {
      expect(Money.fromString('0').isZero()).toBe(true);
      expect(Money.fromString('1').isPositive()).toBe(true);
      expect(Money.fromString('-1').isNegative()).toBe(true);
      expect(Money.fromString('0').isNegativeOrZero()).toBe(true);
    });

    it('min/max', () => {
      expect(Money.max(Money.fromString('1'), Money.fromString('2')).toFixed(1)).toBe('2.0');
      expect(Money.min(Money.fromString('1'), Money.fromString('2')).toFixed(1)).toBe('1.0');
    });
  });

  describe('formatting', () => {
    it('formats negative values correctly', () => {
      expect(Money.fromString('-0.5').toFixed(2)).toBe('-0.50');
    });

    it('converts to number approximately', () => {
      expect(Money.fromString('12.5').toNumber()).toBe(12.5);
    });

    it('scaled accessor returns integer', () => {
      expect(Money.fromString('1.00000001').scaled).toBe(100000001n);
    });
  });
});
