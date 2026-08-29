import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';

describe('Money tick-size helpers', () => {
  describe('roundToIncrement', () => {
    it('rounds to the nearest price tick', () => {
      const inc = Money.fromString('0.01');
      expect(Money.fromString('123.456').roundToIncrement(inc).toFixed(2)).toBe('123.46');
      expect(Money.fromString('123.444').roundToIncrement(inc).toFixed(2)).toBe('123.44');
      expect(Money.fromString('123.440').roundToIncrement(inc).toFixed(2)).toBe('123.44');
    });

    it('rounds quantity to the nearest quantity tick', () => {
      const inc = Money.fromString('0.00000001');
      expect(Money.fromString('0.000000015').roundToIncrement(inc).toFixed(8)).toBe('0.00000002');
      expect(Money.fromString('0.000000011').roundToIncrement(inc).toFixed(8)).toBe('0.00000001');
    });

    it('rounds half-up on magnitude preserving sign', () => {
      const inc = Money.fromString('0.01');
      expect(Money.fromString('1.005').roundToIncrement(inc).toFixed(2)).toBe('1.01');
      expect(Money.fromString('-1.005').roundToIncrement(inc).toFixed(2)).toBe('-1.01');
    });

    it('rejects a zero/negative increment', () => {
      expect(() => Money.fromString('1.00').roundToIncrement(Money.fromString('0'))).toThrow();
      expect(() => Money.fromString('1.00').isMultipleOf(Money.fromString('-0.01'))).toThrow();
    });
  });

  describe('isMultipleOf', () => {
    it('detects whether a value sits on the tick grid', () => {
      const inc = Money.fromString('0.01');
      expect(Money.fromString('123.45').isMultipleOf(inc)).toBe(true);
      expect(Money.fromString('123.456').isMultipleOf(inc)).toBe(false);
    });
  });
});
