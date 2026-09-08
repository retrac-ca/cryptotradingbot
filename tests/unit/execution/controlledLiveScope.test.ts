/**
 * Controlled NDAX LIVE scope — boundary tests.
 *
 * The controlled LIVE scope permits ONLY LIMIT orders with an explicit price,
 * bounded by a maximum base quantity and a maximum quote notional, and at most
 * one unresolved live order at a time. LIVE market orders remain disabled.
 * These tests verify the live submission boundary fails closed and that no
 * silent MARKET→LIMIT conversion or aggressive price rounding can occur.
 *
 * They never contact a real exchange (FakeExchange only).
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine, LiveGateError } from '../../../src/execution/LiveExecutionEngine.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { NewOrder } from '../../../src/order.js';
import { PaperExecutionEngine } from '../../../src/execution/PaperExecutionEngine.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { PaperExecutionConfig } from '../../../src/execution/PaperExecutionTypes.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('controlled-live', 'ledger.json');

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

function riskConfig(): RiskConfig {
  return {
    maxTradeAmount: Money.fromString('1000000'),
    maxPositionSizeFraction: 1,
    maxPortfolioExposureFraction: 1,
    maxDailyLossFraction: 1,
    maxDrawdownFraction: 1,
    cooldownAfterLossMs: 0,
    maxOpenPositions: 1,
    marketDataMaxAgeMs: 60_000,
    marketDataTransportMaxAgeMs: 60_000,
    maxClockSkewMs: 120_000,
  };
}

function riskContext(overrides: Partial<RiskContext> = {}, price = '40000'): RiskContext {
  const bal: Balance = {
    currency: 'CAD',
    total: Money.fromString('100000'),
    available: Money.fromString('100000'),
    held: Money.zero(),
  };
  return {
    symbol: 'BTC/CAD',
    signal: signal('BTC/CAD', 'BUY'),
    nowMs: 1_000_000,
    marketDataTimestampMs: 1_000_000,
    marketDataObservedAtMs: 1_000_000,
    price: Money.fromString(price),
    marketInfo: market,
    quoteBalance: bal,
    deployableQuote: Money.fromString('1000000'),
    portfolioValue: Money.fromString('100000'),
    peakPortfolioValue: Money.fromString('100000'),
    portfolioExposure: Money.fromString('0'),
    currentPosition: Money.fromString('0'),
    externalPosition: Money.fromString('0'),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.fromString('0'),
    unrealizedPnlToday: Money.fromString('0'),
    ...overrides,
  };
}

function buildEngine(
  exchange: FakeExchange,
  limits: { maxLiveQuoteNotional?: string; maxLiveBaseQuantity?: string } = {},
): LiveOrderEngine {
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate,
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString(limits.maxLiveQuoteNotional ?? '1000000'),
    maxLiveBaseQuantity: Money.fromString(limits.maxLiveBaseQuantity ?? '100'),
  });
}

function newOrder(partial: Partial<NewOrder> = {}): NewOrder {
  return {
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'limit',
    price: Money.fromString('40000'),
    quantity: Money.fromString('0.1'),
    clientOrderId: 'c1',
    reason: 'test',
    ...partial,
  };
}

function limitIntent(reason: string, extra: Partial<import('../../../src/execution/LiveExecutionEngine.js').LiveOrderIntent> = {}): import('../../../src/execution/LiveExecutionEngine.js').LiveOrderIntent {
  return { reason, type: 'limit', price: Money.fromString('40000'), ...extra };
}

describe('Controlled LIVE scope — order type boundary', () => {
  it('A: accepts a LIMIT LIVE intent structurally and submits it', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.order.type).toBe('limit');
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(exchange.submittedOrders[0]!.type).toBe('limit');
  });

  it('B: rejects a LIVE MARKET order (never silently converts to LIMIT)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.place(riskContext(), limitIntent('test', { type: 'market' }))).rejects.toThrow(
      /NDAX LIVE market orders are disabled/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(new OrderStore(LEDGER).allOrders().size).toBe(0);
  });

  it('C: rejects a LIVE intent with a missing order type (fail closed, no default)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(
      engine.place(riskContext(), { reason: 'test', type: undefined as never, price: Money.fromString('40000') }),
    ).rejects.toThrow(/live order type is required/);
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(new OrderStore(LEDGER).allOrders().size).toBe(0);
  });

  it('D: rejects a LIVE LIMIT intent with no explicit price', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.place(riskContext(), { reason: 'test', type: 'limit' })).rejects.toThrow(
      /requires an explicit positive limit price/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('E: rejects a zero or negative limit price', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.place(riskContext(), limitIntent('test', { price: Money.zero() }))).rejects.toThrow(
      /requires an explicit positive limit price/,
    );
    await expect(engine.place(riskContext(), limitIntent('test', { price: Money.fromString('-1') }))).rejects.toThrow(
      /requires an explicit positive limit price/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });
});

describe('Controlled LIVE scope — precision and exposure guards', () => {
  it('F: rejects a limit price not on the price tick grid', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.validateOrder(newOrder({ price: Money.fromString('40000.005') }))).rejects.toThrow(LiveGateError);
  });

  it('G: rejects a quantity not on the quantity tick grid', async () => {
    const coarseMarket: MarketInfo = { ...market, quantityTick: Money.fromString('0.001') };
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': coarseMarket } });
    const engine = buildEngine(exchange);
    await expect(engine.validateOrder(newOrder({ quantity: Money.fromString('0.0005') }))).rejects.toThrow(LiveGateError);
  });

  it('H: rejects a quantity above the maximum live base quantity', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, { maxLiveBaseQuantity: '0.01' });
    await expect(engine.validateOrder(newOrder({ quantity: Money.fromString('1') }))).rejects.toThrow(
      /exceeds maximum live base quantity/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('I: rejects a BUY whose quote notional exceeds the maximum', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, { maxLiveQuoteNotional: '1000' });
    // 0.1 * 40000 = 4000 + fee > 1000 => reject.
    await expect(engine.validateOrder(newOrder({ quantity: Money.fromString('0.1') }))).rejects.toThrow(
      /exceeds maximum live quote notional/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('J: BUY notional guard uses the explicit limit price, not a market estimate', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    // Reference price is 40000; limit price 100000. Cap 40000: at the reference
    // price 0.5*40000=20000 <= 40000, but at the LIMIT price 0.5*100000=50000 > 40000.
    const engine = buildEngine(exchange, { maxLiveQuoteNotional: '40000' });
    await expect(engine.validateOrder(newOrder({ quantity: Money.fromString('0.5'), price: Money.fromString('100000') }))).rejects.toThrow(
      /exceeds maximum live quote notional/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('K: SELL constraints enforced (cannot sell beyond held base, respects max base qty)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.25' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, { maxLiveBaseQuantity: '0.01' });
    // Even with BTC available, the max base quantity cap rejects an oversized SELL.
    await expect(engine.validateOrder(newOrder({ side: 'SELL', quantity: Money.fromString('1') }))).rejects.toThrow(
      /exceeds maximum live base quantity/,
    );
    // A SELL beyond held base is rejected by balance validation.
    const engine2 = buildEngine(exchange, { maxLiveBaseQuantity: '100' });
    await expect(engine2.validateOrder(newOrder({ side: 'SELL', quantity: Money.fromString('1') }))).rejects.toThrow(LiveGateError);
  });
});

describe('Controlled LIVE scope — one-in-flight order guard', () => {
  it('L: one unresolved LIVE order blocks another', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await engine.place(riskContext(), limitIntent('first'));
    await expect(engine.place(riskContext(), limitIntent('second'))).rejects.toThrow(
      /at most one in-flight live order/,
    );
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('M: a resolved terminal no-fill order allows a new order', async () => {
    // 'cancel' behavior makes the fake order terminal without settling funds, so
    // a subsequent order can be afforded by the same balance.
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market }, orderBehavior: { kind: 'cancel' } });
    const engine = buildEngine(exchange);
    const first = await engine.place(riskContext(), limitIntent('first'));
    await engine.refreshOrder(first.order); // fake back-reports CANCELED => terminal
    const second = await engine.place(riskContext(), limitIntent('second'));
    expect(second.order.status).toBe('SUBMITTED');
    expect(exchange.submittedOrders).toHaveLength(2);
  });

  it('N: an UNKNOWN (reconciliation-required) order blocks a new order', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange);
    const first = await engine.place(riskContext(), limitIntent('first'));
    expect(first.order.status).toBe('UNKNOWN');
    await expect(engine.place(riskContext(), limitIntent('second'))).rejects.toThrow(
      /at most one in-flight live order/,
    );
    // Only the first order ever reached the exchange; the second was refused.
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('O: a RECONCILIATION_REQUIRED (UNKNOWN) ledger order blocks a new order', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const now = Date.now();
    // Seed an UNKNOWN live order AFTER building the engine (buildEngine clears the
    // ledger). This is the state a reconciliation-required order is recorded as.
    new OrderStore(LEDGER).save({
      clientOrderId: 'live-BTCCAD-00000000-0000-4000-8000-000000000000',
      exchangeOrderId: null,
      symbol: 'BTC/CAD',
      side: 'BUY',
      type: 'limit',
      status: 'UNKNOWN',
      quantity: Money.fromString('0.1'),
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: Money.fromString('40000'),
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'unknown',
      reason: 'reconcile-required',
      createdAtMs: now,
      updatedAtMs: now,
    });
    await expect(engine.place(riskContext(), limitIntent('second'))).rejects.toThrow(
      /at most one in-flight live order/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('P: the one-in-flight restriction survives a restart (durable ledger)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await engine.place(riskContext(), limitIntent('first'));
    // Simulate a restart with a fresh engine reading the same durable ledger.
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    const restarted = new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
      gate,
      killSwitch: false,
      maxLiveQuoteNotional: Money.fromString('1000000'),
      maxLiveBaseQuantity: Money.fromString('100'),
    });
    await expect(restarted.place(riskContext(), limitIntent('second'))).rejects.toThrow(
      /at most one in-flight live order/,
    );
    expect(exchange.submittedOrders).toHaveLength(1);
  });
});

describe('Controlled LIVE scope — no silent conversion / rounding / live enablement', () => {
  it('S: no path silently converts MARKET to LIMIT', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.place(riskContext(), limitIntent('test', { type: 'market' }))).rejects.toThrow(
      /market orders are disabled/,
    );
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(new OrderStore(LEDGER).allOrders().size).toBe(0);
  });

  it('T: a limit price is not silently rounded to be more aggressive (off-tick rejected for BUY and SELL)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '1' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    // BUY off-tick price would round UP to 40000.01 if rounded; it is rejected instead.
    await expect(engine.validateOrder(newOrder({ side: 'BUY', price: Money.fromString('40000.005') }))).rejects.toThrow(LiveGateError);
    // SELL off-tick price would round DOWN to 40000.00 if rounded; it is rejected instead.
    await expect(engine.validateOrder(newOrder({ side: 'SELL', price: Money.fromString('40000.005'), quantity: Money.fromString('0.1') }))).rejects.toThrow(LiveGateError);
    // A valid on-tick price is passed through unchanged (no rounding).
    const ok = await engine.validateOrder(newOrder({ side: 'BUY', price: Money.fromString('40000.01'), quantity: Money.fromString('0.1') }));
    expect(ok).toBeUndefined();
  });

  it('R: the NDAX adapter still advertises supportsOrderPlacement=false', async () => {
    const { NdaxAdapter } = await import('../../../src/exchanges/ndax/NdaxAdapter.js');
    const adapter = new NdaxAdapter({
      credentials: { apiKey: '', apiSecret: '', userId: '' },
    });
    expect(adapter.capabilities.supportsOrderPlacement).toBe(false);
  });

  it('Q: PAPER market-order behavior remains unchanged (paper engine still fills a market order)', async () => {
    const cfg: PaperExecutionConfig = { feeFraction: 0.0005, slippageFraction: 0.0005, fillFraction: 1 };
    const portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    const engine = new PaperExecutionEngine(cfg, portfolio);
    const order = engine.submitMarketOrder(
      {
        symbol: 'BTC/CAD',
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.01'),
        clientOrderId: 'paper-x',
        reason: 'test',
      },
      { referencePrice: Money.fromString('40000'), bid: Money.fromString('39999'), ask: Money.fromString('40001') },
      Date.now(),
    );
    expect(order.status).toBe('FILLED');
    expect(engine.currentPortfolio.position('BTC/CAD')!.quantity.toFixed(8)).toBe('0.01000000');
  });
});
