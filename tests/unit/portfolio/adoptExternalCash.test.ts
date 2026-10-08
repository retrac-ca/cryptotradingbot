/**
 * `Portfolio.adoptExternalCash` — explicit external quote -> bot-managed capital.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';

describe('Portfolio.adoptExternalCash', () => {
  it('adds the amount to managed cash', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100')]]));
    const next = p.adoptExternalCash('CAD', Money.fromString('26.02273575'));
    expect(next.cash('CAD').toFixed(8)).toBe('126.02273575');
    // Immutable: the original is untouched.
    expect(p.cash('CAD').toFixed(8)).toBe('100.00000000');
  });

  it('raises the peak-equity baseline', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100')]]));
    expect(p.stateModel.peakEquity.toFixed(8)).toBe('100.00000000');
    const next = p.adoptExternalCash('CAD', Money.fromString('26.02273575'));
    expect(next.stateModel.peakEquity.toFixed(8)).toBe('126.02273575');
  });

  it('creates no position and does not change realized P&L', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100')]]));
    const next = p.adoptExternalCash('CAD', Money.fromString('26.02273575'));
    expect(next.stateModel.positions.size).toBe(0);
    expect(next.stateModel.realizedPnl.toFixed(8)).toBe('0.00000000');
  });

  it('rejects a zero or negative amount (fail closed)', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100')]]));
    expect(() => p.adoptExternalCash('CAD', Money.zero())).toThrow();
    expect(() => p.adoptExternalCash('CAD', Money.fromString('-1'))).toThrow();
  });
});
