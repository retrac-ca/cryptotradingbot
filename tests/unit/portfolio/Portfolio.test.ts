import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';

function seed(initialCad: string): Portfolio {
  const cash = new Map<string, Money>();
  cash.set('CAD', Money.fromString(initialCad));
  return Portfolio.empty(cash);
}

describe('Portfolio — buy / position math', () => {
  it('opens a long position on the first buy', () => {
    const p = seed('10000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    const pos = p.position('BTC/CAD')!;
    expect(pos.quantity.toFixed(8)).toBe('0.10000000');
    expect(pos.averageEntryPrice.toFixed(8)).toBe('40000.00000000');
    expect(pos.costBasis.toFixed(2)).toBe('4000.00');
    expect(p.cash('CAD').toFixed(2)).toBe('6000.00');
  });

  it('scales into a position and recomputes the average entry price', () => {
    let p = seed('100000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    p = p.applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('60000'), Money.zero());
    const pos = p.position('BTC/CAD')!;
    expect(pos.quantity.toFixed(8)).toBe('0.20000000');
    expect(pos.averageEntryPrice.toFixed(8)).toBe('50000.00000000');
    expect(pos.costBasis.toFixed(2)).toBe('10000.00');
  });

  it('includes entry fees in cost basis and average price', () => {
    const fee = Money.fromString('20');
    const p = seed('10000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), fee);
    const pos = p.position('BTC/CAD')!;
    expect(pos.costBasis.toFixed(2)).toBe('4020.00');
    expect(pos.averageEntryPrice.toFixed(8)).toBe('40200.00000000');
  });
});

describe('Portfolio — sell / realized P&L', () => {
  it('realizes P&L on a partial sell and keeps remaining cost basis', () => {
    let p = seed('100000')
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('50000'), Money.zero());
    p = p.applyFill('BTC/CAD', 'SELL', Money.fromString('0.1'), Money.fromString('60000'), Money.zero());
    const pos = p.position('BTC/CAD')!;
    expect(pos.quantity.toFixed(8)).toBe('0.10000000');
    expect(pos.costBasis.toFixed(2)).toBe('5000.00');
    expect(pos.realizedPnl.toFixed(2)).toBe('1000.00');
    expect(p.stateModel.realizedPnl.toFixed(2)).toBe('1000.00');
    expect(p.cash('CAD').toFixed(2)).toBe('96000.00'); // 100000 - 10000 + 6000
  });

  it('closes a position fully and removes it', () => {
    let p = seed('100000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('50000'), Money.zero());
    p = p.applyFill('BTC/CAD', 'SELL', Money.fromString('0.2'), Money.fromString('60000'), Money.zero());
    expect(p.position('BTC/CAD')).toBeNull();
    expect(p.stateModel.realizedPnl.toFixed(2)).toBe('2000.00');
  });

  it('charges sell fees against realized P&L', () => {
    let p = seed('100000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('50000'), Money.zero());
    p = p.applyFill('BTC/CAD', 'SELL', Money.fromString('0.2'), Money.fromString('60000'), Money.fromString('60'));
    // realized = (60000-50000)*0.2 - 60 = 2000 - 60 = 1940
    expect(p.stateModel.realizedPnl.toFixed(2)).toBe('1940.00');
    expect(p.stateModel.totalFees.toFixed(2)).toBe('60.00');
  });

  it('rejects a sell that exceeds the held position (cannot go short)', () => {
    const p = seed('100000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('50000'), Money.zero());
    expect(() =>
      p.applyFill('BTC/CAD', 'SELL', Money.fromString('0.3'), Money.fromString('60000'), Money.zero()),
    ).toThrow(/exceeds held position/);
  });

  it('rejects a sell with no position', () => {
    expect(() =>
      seed('100000').applyFill('BTC/CAD', 'SELL', Money.fromString('0.1'), Money.fromString('50000'), Money.zero()),
    ).toThrow(/no held position/);
  });
});

describe('Portfolio — mark to market, equity, exposure', () => {
  it('computes equity, unrealized P&L, and exposure from prices', () => {
    let p = seed('100000').applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('50000'), Money.zero());
    const prices = new Map<string, Money>();
    prices.set('BTC/CAD', Money.fromString('55000'));
    const mtm = p.markToMarket(prices);
    expect(mtm.equity.toFixed(2)).toBe('101000.00'); // 100000-10000 + 0.2*55000 = 90000+11000
    expect(mtm.unrealizedPnl.toFixed(2)).toBe('1000.00'); // 0.2*(55000-50000)
    expect(p.exposure(prices).toFixed(2)).toBe('11000.00');
  });
});
