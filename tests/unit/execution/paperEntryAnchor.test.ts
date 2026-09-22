import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PaperExecutionEngine } from '../../../src/execution/PaperExecutionEngine.js';

const SYMBOL = 'BTC/CAD';

function engine(seedCad = '100000'): PaperExecutionEngine {
  const cash = new Map<string, Money>([['CAD', Money.fromString(seedCad)]]);
  return new PaperExecutionEngine(
    { feeFraction: 0, slippageFraction: 0, fillFraction: 1 },
    Portfolio.empty(cash),
  );
}

const market = {
  referencePrice: Money.fromString('100'),
  bid: Money.fromString('99.99'),
  ask: Money.fromString('100.01'),
};

describe('PaperExecutionEngine entry anchor', () => {
  it('carries a PaperOrderRequest anchor through to the portfolio (end-to-end)', () => {
    const ex = engine();
    const anchor = Money.fromString('95.5');
    const order = ex.submitMarketOrder(
      {
        clientOrderId: 'paper-anchor-1',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.5'),
        reason: 'test',
        entryAnchorPrice: anchor,
      },
      market,
      1000,
    );
    expect(order.status).toBe('FILLED');
    expect(ex.currentPortfolio.position(SYMBOL)!.entryAnchorPrice!.equals(anchor)).toBe(true);
  });

  it('passes a request anchor unchanged; a scaling BUY cannot overwrite it', () => {
    const ex = engine();
    const anchor = Money.fromString('95.5');
    ex.submitMarketOrder(
      {
        clientOrderId: 'paper-anchor-2a',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.5'),
        reason: 'test',
        entryAnchorPrice: anchor,
      },
      market,
      1000,
    );
    ex.submitMarketOrder(
      {
        clientOrderId: 'paper-anchor-2b',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.5'),
        reason: 'test',
        entryAnchorPrice: Money.fromString('150'),
      },
      market,
      2000,
    );
    expect(ex.currentPortfolio.position(SYMBOL)!.entryAnchorPrice!.equals(anchor)).toBe(true);
  });

  it('a BUY request without an anchor stores null', () => {
    const ex = engine();
    ex.submitMarketOrder(
      {
        clientOrderId: 'paper-anchor-3',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.5'),
        reason: 'test',
      },
      market,
      1000,
    );
    expect(ex.currentPortfolio.position(SYMBOL)!.entryAnchorPrice).toBeNull();
  });

  it('carries the anchor through the marketable-limit path', () => {
    const ex = engine();
    const anchor = Money.fromString('97.25');
    const order = ex.submitLimitOrder(
      {
        clientOrderId: 'paper-anchor-4',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'limit',
        quantity: Money.fromString('0.5'),
        // BUY limit >= ask => marketable, so it fills immediately.
        limitPrice: Money.fromString('100.01'),
        reason: 'test',
        entryAnchorPrice: anchor,
      },
      market,
      3000,
    );
    expect(order.status).toBe('FILLED');
    expect(order.side).toBe('BUY');
    expect(ex.currentPortfolio.position(SYMBOL)!.entryAnchorPrice!.equals(anchor)).toBe(true);
  });
});
