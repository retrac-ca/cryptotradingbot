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

// --- C-2: paper slippage must never overdraw quote cash. ---
//
// The RiskManager pre-approves a BUY against the REFERENCE price (ask) plus an
// estimated taker fee. The PaperExecutionEngine fills at the reference price
// ADJUSTED for positive slippage, so for a near-full-deployment BUY the true cost
// (fill notional + fee) can exceed what the funding check authorized. The fix
// enforces the accounting invariant at the execution boundary: reject a BUY whose
// true slippage-adjusted cost exceeds the currently-deployable quote (cash minus
// reserved) BEFORE mutating any state. A BUY must never drive paper cash negative.
describe('C-2 — paper BUY never overdraws quote cash', () => {
  const TIGHT = '1000'; // quote cash that is fully (nearly) deployable at the reference price.

  it('full-deployment BUY + positive slippage rejects and never produces negative cash', () => {
    // At reference price 40000 this BUY is nearly the whole $1000 deployable pool;
    // with +0.05% slippage the true cost is ~1001.00 > 1000.
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitMarketOrder(req({ quantity: Money.fromString('0.025') }), MARKET, 1000);
    expect(order.status).toBe('REJECTED');
    expect(order.reason).toContain('overdraw');
    const cash = engine.currentPortfolio.cash('CAD');
    expect(cash.isNegative()).toBe(false);
    expect(cash.toFixed(2)).toBe('1000.00'); // unchanged: no mutation occurred
    expect(engine.currentPortfolio.position('BTC/CAD')).toBeNull();
  });

  it('near-boundary BUY with funds for the true slippage-adjusted cost fills and stays positive', () => {
    // q=0.024 at slippage-adjusted 40020 -> cost 960.96024 <= 1000, so it fills.
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitMarketOrder(req({ quantity: Money.fromString('0.024') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    expect(order.averagePrice?.toFixed(2)).toBe('40020.00'); // slippage applied
    const cash = engine.currentPortfolio.cash('CAD');
    expect(cash.isNegative()).toBe(false);
    expect(cash.toFixed(5)).toBe('39.03976');
  });

  it('insufficient funds for the slippage-adjusted cost rejects safely (risk would approve)', () => {
    // q=0.02498 -> risk-required at reference (999.6996) <= 1000, but the true
    // slippage-adjusted cost (1000.1994498) exceeds the deployable pool.
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitMarketOrder(req({ quantity: Money.fromString('0.02498') }), MARKET, 1000);
    expect(order.status).toBe('REJECTED');
    expect(order.reason).toContain('overdraw');
    const cash = engine.currentPortfolio.cash('CAD');
    expect(cash.isNegative()).toBe(false);
    expect(cash.toFixed(2)).toBe('1000.00');
    expect(engine.currentPortfolio.position('BTC/CAD')).toBeNull();
  });

  it('normal slippage is applied honestly on a successful fill', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitMarketOrder(req({ quantity: Money.fromString('0.024') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    // reference 40000 * (1 + 0.0005) = 40020
    expect(order.averagePrice?.toFixed(2)).toBe('40020.00');
    // fee = 0.024 * 40020 * 0.0005 = 0.480240
    expect(order.fee.toFixed(6)).toBe('0.480240');
    // quantity unchanged (no silent reduction)
    expect(order.filledQuantity.toFixed(8)).toBe('0.02400000');
  });

  it('fee accounting is internally consistent with the actual slippage-adjusted fill', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitMarketOrder(req({ quantity: Money.fromString('0.024') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    const pos = engine.currentPortfolio.position('BTC/CAD')!;
    // cost basis = notional + fee = 960.480000 + 0.480240 = 960.960240
    expect(pos.costBasis.toFixed(8)).toBe('960.96024000');
    // average entry price (fee-inclusive) = 960.96024 / 0.024 = 40040.01
    expect(pos.averageEntryPrice.toFixed(2)).toBe('40040.01');
    expect(pos.feesPaid.toFixed(6)).toBe('0.480240');
  });

  it('portfolio conservation: a fill neither manufactures nor destroys value except modeled fee', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    engine.submitMarketOrder(req({ quantity: Money.fromString('0.024') }), MARKET, 1000);
    const p = engine.currentPortfolio;
    // Equity at cost-basis baseline is unchanged: cash + cost basis = starting cash.
    const equity = Portfolio.equityOf(p.stateModel);
    expect(equity.toFixed(2)).toBe('1000.00');
    // cash decreased by exactly (notional + fee); position increased by exactly fillQty.
    expect(p.cash('CAD').toFixed(5)).toBe('39.03976');
    expect(p.position('BTC/CAD')!.quantity.toFixed(8)).toBe('0.02400000');
  });

  it('the fill cannot spend quote already reserved by an in-flight order', () => {
    // Reserve $300 -> deployable = $700. A $960.96-cost BUY must be refused even
    // though the raw cash is $1000: spending it would occupy reserved capital.
    const reserved = seededPortfolio(TIGHT).reserveQuote('CAD', Money.fromString('300'));
    expect(reserved.deployableQuote('CAD').toFixed(2)).toBe('700.00');
    const engine = new PaperExecutionEngine(CONFIG, reserved);
    const tooBig = engine.submitMarketOrder(req({ quantity: Money.fromString('0.024') }), MARKET, 1000);
    expect(tooBig.status).toBe('REJECTED');
    expect(tooBig.reason).toContain('overdraw');
    expect(engine.currentPortfolio.reserved('CAD').toFixed(2)).toBe('300.00'); // untouched
    expect(engine.currentPortfolio.cash('CAD').toFixed(2)).toBe('1000.00');
    expect(engine.currentPortfolio.position('BTC/CAD')).toBeNull();

    // A BUY whose true cost is within deployable still fills and leaves the
    // reservation fully intact (never consumed by the fill).
    const ok = new PaperExecutionEngine(CONFIG, reserved);
    const order = ok.submitMarketOrder(req({ quantity: Money.fromString('0.01') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    expect(ok.currentPortfolio.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(ok.currentPortfolio.cash('CAD').toFixed(4)).toBe('599.5999');
  });

  it('the guard also rejects a marketable BUY limit that would overdraw quote', () => {
    const engine = new PaperExecutionEngine(CONFIG, seededPortfolio(TIGHT));
    const order = engine.submitLimitOrder(
      req({ type: 'limit', limitPrice: Money.fromString('40100'), quantity: Money.fromString('0.025') }),
      MARKET,
      1000,
    );
    expect(order.status).toBe('REJECTED');
    expect(order.reason).toContain('overdraw');
    expect(engine.currentPortfolio.cash('CAD').toFixed(2)).toBe('1000.00');
    expect(engine.currentPortfolio.position('BTC/CAD')).toBeNull();
    expect(engine.openOrderList).toHaveLength(0);
  });

  it('the guard does not change a normal SELL (which only credits quote)', () => {
    // Seed a funded 0.01 long (cost 399 + fee 0.1 = 399.1) on $1000 cash.
    const p = seededPortfolio(TIGHT).applyFill('BTC/CAD', 'BUY', Money.fromString('0.01'), Money.fromString('39900'), Money.fromString('0.1'));
    const engine = new PaperExecutionEngine(CONFIG, p);
    const order = engine.submitMarketOrder(req({ side: 'SELL', quantity: Money.fromString('0.005') }), MARKET, 1000);
    expect(order.status).toBe('FILLED');
    // SELL fills at 40000 * (1 - 0.0005) = 39980 and credits quote.
    expect(order.averagePrice?.toFixed(2)).toBe('39980.00');
    expect(engine.currentPortfolio.cash('CAD').isNegative()).toBe(false);
    // proceeds = 0.005*39980 minus fee(0.09995) credited back.
    expect(engine.currentPortfolio.cash('CAD').toFixed(4)).toBe('800.7000');
  });
});
