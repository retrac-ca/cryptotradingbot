import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import type { NewOrder } from '../../../src/order.js';
import type { MarketInfo } from '../../../src/types.js';

function buyOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'limit',
    quantity: Money.fromString('0.5'),
    price: Money.fromString('88000'),
    clientOrderId: 'test-1',
    reason: 'test',
    ...overrides,
  };
}

function defaultMarkets(exchange: FakeExchange): void {
  const market: MarketInfo = {
    symbol: 'BTC/CAD',
    exchangeId: '1',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 8,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: null,
    minOrderQuote: null,
    supportsMarketOrders: true,
    feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  };
  exchange.setMarkets([market]);
}

describe('FakeExchange', () => {
  it('places a market order and settles balances (fill)', async () => {
    const ex = new FakeExchange({
      balances: { CAD: '100000', BTC: '1' },
      orderBooks: { 'BTC/CAD': { symbol: 'BTC/CAD', timestampMs: 0, bids: [], asks: [{ price: Money.fromString('88000'), quantity: Money.fromString('1') }] } },
    });
    defaultMarkets(ex);
    const res = await ex.placeOrder(buyOrder({ type: 'market', price: undefined }));
    expect(res.exchangeOrderId).toBeTruthy();
    const order = ex.getOrders()[0];
    expect(order.status).toBe('FILLED');
    expect(order.filledQuantity.toFixed(2)).toBe('0.50');
    // CAD decreased by 0.5 * 88000 = 44000
    expect(ex.getBalance('CAD').toFixed(2)).toBe('56000.00');
    expect(ex.getBalance('BTC').toFixed(2)).toBe('1.50');
  });

  it('records submitted orders for audit', async () => {
    const ex = new FakeExchange();
    defaultMarkets(ex);
    await ex.placeOrder(buyOrder());
    expect(ex.submittedOrders.length).toBe(1);
    expect(ex.submittedOrders[0]!.clientOrderId).toBe('test-1');
  });

  it('handles a partial fill', async () => {
    const ex = new FakeExchange({ orderBehavior: { kind: 'partialFill', fillFraction: Money.fromString('0.4') } });
    defaultMarkets(ex);
    const res = await ex.placeOrder(buyOrder());
    expect(res.exchangeOrderId).toBeTruthy();
    const order = ex.getOrders()[0];
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity.toFixed(2)).toBe('0.20');
  });

  it('handles an order rejection without settlement', async () => {
    const ex = new FakeExchange({
      balances: { CAD: '100000' },
      orderBehavior: { kind: 'reject', reason: 'insufficient funds' },
    });
    defaultMarkets(ex);
    await ex.placeOrder(buyOrder());
    const order = ex.getOrders()[0];
    expect(order.status).toBe('REJECTED');
    expect(ex.getBalance('CAD').toFixed(2)).toBe('100000.00');
  });

  it('handles a cancelling behavior', async () => {
    const ex = new FakeExchange({ orderBehavior: { kind: 'cancel' } });
    defaultMarkets(ex);
    await ex.placeOrder(buyOrder());
    expect(ex.getOrders()[0]!.status).toBe('CANCELED');
  });

  it('explicitly signals an unknown order submission outcome', async () => {
    const ex = new FakeExchange({ unknownOrderSubmissions: true });
    defaultMarkets(ex);
    const res = await ex.placeOrder(buyOrder());
    expect(res.exchangeOrderId).toBeNull();
    expect(res.unknownOutcome).toBe(true);
  });

  it('cancels an open order and confirms', async () => {
    const ex = new FakeExchange({ orderBehavior: { kind: 'open' } });
    defaultMarkets(ex);
    const res = await ex.placeOrder(buyOrder({ price: Money.fromString('80000') }));
    expect(ex.getOrders()[0]!.status).toBe('OPEN');
    const cancel = await ex.cancelOrder('BTC/CAD', res.exchangeOrderId!);
    expect(cancel.acknowledged).toBe(true);
    expect(cancel.orderStatus).toBe('CANCELED');
    expect(ex.getOrders()[0]!.status).toBe('CANCELED');
  });

  it('does not cancel an already-filled order', async () => {
    const ex = new FakeExchange({ orderBehavior: { kind: 'fill' } });
    defaultMarkets(ex);
    const res = await ex.placeOrder(buyOrder());
    const cancel = await ex.cancelOrder('BTC/CAD', res.exchangeOrderId!);
    expect(cancel.acknowledged).toBe(false);
  });

  it('injects a network failure per method', async () => {
    const ex = new FakeExchange({ failures: { getTicker: { kind: 'network' } } });
    defaultMarkets(ex);
    ex.setTicker('BTC/CAD', {});
    await expect(ex.getTicker('BTC/CAD')).rejects.toThrow(/network/);
  });

  it('injects a one-shot failure then recovers', async () => {
    const ex = new FakeExchange({ failures: { health: { kind: 'timeout', once: true } } });
    await expect(ex.health()).rejects.toThrow();
    await expect(ex.health()).resolves.toMatchObject({ connected: true });
  });

  it('returns balances reflecting available = total - held', async () => {
    const ex = new FakeExchange({ balances: { BTC: '1.5' } });
    ex.setBalance('CAD', '100');
    const balances = await ex.getBalances();
    const btc = balances.find((b) => b.currency === 'BTC')!;
    expect(btc.total.toFixed(2)).toBe('1.50');
    expect(btc.available.toFixed(2)).toBe('1.50');
    expect(btc.held.isZero()).toBe(true);
  });

  it('advertises order-placement capability', async () => {
    const ex = new FakeExchange();
    expect(ex.capabilities.supportsOrderPlacement).toBe(true);
    expect(ex.capabilities.publicDataRequiresAuth).toBe(false);
  });
});
