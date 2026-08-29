import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PaperExecutionEngine } from '../../../src/execution/PaperExecutionEngine.js';
import type { PaperExecutionConfig, PaperMarket, PaperOrderRequest } from '../../../src/execution/PaperExecutionTypes.js';

function seededPortfolio(initialCad = '10000'): Portfolio {
  const cash = new Map<string, Money>();
  cash.set('CAD', Money.fromString(initialCad));
  return Portfolio.empty(cash);
}

const CONFIG: PaperExecutionConfig = {
  feeFraction: 0.0005,
  slippageFraction: 0.0005,
  fillFraction: 1,
};

const MARKET: PaperMarket = {
  referencePrice: Money.fromString('40000'),
  bid: Money.fromString('39900'),
  ask: Money.fromString('40100'),
};

function req(over: Partial<PaperOrderRequest>): PaperOrderRequest {
  return {
    clientOrderId: 'o1',
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    quantity: Money.fromString('0.1'),
    reason: 'test',
    ...over,
  };
}

describe('PaperExecutionEngine — market orders', () => {
  it('fills a BUY fully at the slippage-adjusted price and charges a fee', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio());
    const order = engine.submitMarketOrder(req({}), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    // 40000 * 1.0005 = 40020
    expect(order.averagePrice?.toFixed(2)).toBe('40020.00');
    expect(order.filledQuantity.toFixed(8)).toBe('0.10000000');
    // fee = 0.1 * 40020 * 0.0005 = 2.001
    expect(order.fee.toFixed(3)).toBe('2.001');
    const pos = engine.currentPortfolio.position('BTC/CAD')!;
    // average entry price includes the fee: (0.1*40020 + 2.001)/0.1 = 40040.01
    expect(pos.averageEntryPrice.toFixed(2)).toBe('40040.01');
    // cash: 10000 - (0.1*40020 + 2.001) = 10000 - 4004.001 = 5995.999
    expect(engine.currentPortfolio.cash('CAD').toFixed(3)).toBe('5995.999');
  });

  it('SELL applies slippage downward and realizes proceeds', () => {
    let p = seededPortfolio().applyFill('BTC/CAD', 'BUY', Money.fromString('0.2'), Money.fromString('40000'), Money.zero());
    const engine = new PaperExecutionEngine(CONFIG, p);
    const order = engine.submitMarketOrder(req({ side: 'SELL', quantity: Money.fromString('0.1') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    // 40000 * 0.9995 = 39980
    expect(order.averagePrice?.toFixed(2)).toBe('39980.00');
    expect(engine.currentPortfolio.position('BTC/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
  });

  it('rejects a SELL exceeding the held position and leaves the portfolio untouched', () => {
    const start = seededPortfolio();
    const engine = new PaperExecutionEngine(CONFIG, start);
    const order = engine.submitMarketOrder(
      req({ side: 'SELL', quantity: Money.fromString('0.5') }),
      MARKET,
      1000,
    );
    expect(order.status).toBe('REJECTED');
    expect(order.reason).toContain('exceeds held position');
    expect(engine.currentPortfolio.position('BTC/CAD')).toBeNull();
    expect(engine.currentPortfolio.cash('CAD').toFixed(2)).toBe('10000.00');
  });

  it('rejects a zero/negative quantity', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio());
    const order = engine.submitMarketOrder(req({ quantity: Money.zero() }), MARKET, 1000);
    expect(order.status).toBe('REJECTED');
  });
});

describe('PaperExecutionEngine — limit orders', () => {
  it('fills a marketable BUY limit immediately', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio());
    const order = engine.submitLimitOrder(
      req({ type: 'limit', limitPrice: Money.fromString('40100') }),
      MARKET,
      1000,
    );
    expect(order.status).toBe('FILLED');
    expect(engine.openOrderList).toHaveLength(0);
  });

  it('rests a non-marketable BUY limit and allows cancellation', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio());
    const order = engine.submitLimitOrder(
      req({ type: 'limit', limitPrice: Money.fromString('39000'), clientOrderId: 'lim1' }),
      MARKET,
      1000,
    );
    expect(order.status).toBe('OPEN');
    expect(engine.openOrderList).toHaveLength(1);
    const canceled = engine.cancelOrder('lim1', 2000);
    expect(canceled?.status).toBe('CANCELED');
    expect(engine.openOrderList).toHaveLength(0);
    expect(engine.orderHistory.find((o) => o.clientOrderId === 'lim1')?.status).toBe('CANCELED');
  });
});

describe('PaperExecutionEngine — partial fills', () => {
  it('partial-fills a limit order when fillFraction < 1', () => {
    const partial: PaperExecutionConfig = { ...CONFIG, fillFraction: 0.5 };
    const engine = new PaperExecutionEngine(partial, seededPortfolio());
    const order = engine.submitLimitOrder(
      req({ type: 'limit', limitPrice: Money.fromString('40100'), quantity: Money.fromString('0.2') }),
      MARKET,
      1000,
    );
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity.toFixed(8)).toBe('0.10000000');
    expect(engine.currentPortfolio.position('BTC/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
  });
});
