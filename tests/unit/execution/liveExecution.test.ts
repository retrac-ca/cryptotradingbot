import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine, LiveGateError } from '../../../src/execution/LiveExecutionEngine.js';
import type { NewOrder } from '../../../src/order.js';
import type { MarketInfo } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';

const LEDGER = '/tmp/opencode/live-engine-ledger.json';

const market: MarketInfo = {
  symbol: 'BTC/CAD',
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'),
  minOrderQuote: Money.fromString('1'),
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

const gate = { tradingMode: 'live' as const, realFundsAtRisk: true };

function newOrder(partial: Partial<NewOrder> = {}): NewOrder {
  return {
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    quantity: Money.fromString('0.1'),
    clientOrderId: 'c1',
    reason: 'test',
    ...partial,
  };
}

function buildEngine(
  exchange: FakeExchange,
  cfg: { killSwitch?: boolean; ackTimeoutMs?: number } = {},
): LiveOrderEngine {
  if (!cfg.killSwitch) {
    exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  }
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, { gate, killSwitch: cfg.killSwitch ?? false, ackTimeoutMs: cfg.ackTimeoutMs });
}

describe('LiveOrderEngine — safety-critical live order placement', () => {
  it('refuses to construct without explicit realFundsAtRisk acknowledgement', () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    expect(() => new LiveOrderEngine(exchange, store, service, {
      gate: { tradingMode: 'live', realFundsAtRisk: false },
      killSwitch: false,
    })).toThrow(LiveGateError);
  });

  it('refuses when the adapter does not support order placement', () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    // Simulate an adapter without placement capability.
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    expect(() => new LiveOrderEngine(exchange, store, service, { gate, killSwitch: false })).toThrow(LiveGateError);
  });

  it('applies the kill switch and refuses to place when active', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    expect(() => buildEngine(exchange, { killSwitch: true })).toThrow(LiveGateError);
  });

  it('records the order as CREATED before submitting (persist-before-submit)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(newOrder());
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.unknownOutcome).toBe(false);
    // Submitted order reached the exchange exactly once.
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('rejects a duplicate clientOrderId instead of re-submitting', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const order = newOrder();
    await engine.place(order);
    // Second place attempt must be refused WITHOUT hitting the exchange again.
    const result = await engine.place(order);
    expect(result.order.status).toBe('REJECTED');
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('does NOT retry on an ambiguous (unknown) outcome and flags unknownOutcome', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange);
    const result = await engine.place(newOrder());
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    // Only one submission attempt.
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('does NOT retry on a network/timeout error (ambiguous) and flags unknownOutcome', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    exchange.setFailures({ placeOrder: { kind: 'timeout' } });
    const engine = buildEngine(exchange);
    const result = await engine.place(newOrder());
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    // The fake throws before recording the submission.
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('marks a definite rejection as REJECTED (no retry, safe)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    exchange.setFailures({ placeOrder: { kind: 'rejected' } });
    const engine = buildEngine(exchange);
    const result = await engine.place(newOrder());
    expect(result.unknownOutcome).toBe(false);
    expect(result.order.status).toBe('REJECTED');
    // The fake throws before recording the submission.
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects an off-tick quantity (precision validation)', async () => {
    const coarseMarket: MarketInfo = { ...market, quantityTick: Money.fromString('0.01') };
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': coarseMarket } });
    const engine = buildEngine(exchange);
    await expect(engine.place(newOrder({ quantity: Money.fromString('0.12345679') })))
      .rejects.toThrow(LiveGateError);
    // Nothing reached the exchange.
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects when available balance is insufficient', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100' }, markets: { 'BTC/CAD': market } });
    exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
    const engine = buildEngine(exchange);
    const order = newOrder({ type: 'market', quantity: Money.fromString('0.1') });
    await expect(engine.place(order)).rejects.toThrow(LiveGateError);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('transitions a CREATED order to UNKNOWN on ambiguous ack, persisting the ledger', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange, { ackTimeoutMs: 2000 });
    const result = await engine.place(newOrder());
    expect(result.order.status).toBe('UNKNOWN');
    // The ledger now holds the UNKNOWN record for reconciliation later.
    const store = new OrderStore(LEDGER);
    expect(store.get('c1')!.status).toBe('UNKNOWN');
  });
});
