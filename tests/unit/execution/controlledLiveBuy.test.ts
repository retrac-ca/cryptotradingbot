/**
 * Supervised controlled BUY — engine reservation lifecycle.
 *
 * These tests exercise the LiveOrderEngine's optional BUY reservation hooks
 * (reserve-before-submit) and the extended controlled authorization, using only
 * FakeExchange. NO real order is ever placed.
 */

import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import { createControlledLiveAuthorization } from '../../../src/execution/ControlledLiveAuthorization.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { NewOrder } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('controlled-buy', 'ledger.json');

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

function buyAuth() {
  return createControlledLiveAuthorization({
    side: 'BUY',
    type: 'limit',
    maxBaseQuantity: Money.fromString('0.01'),
    maxQuoteNotional: Money.fromString('1000'),
  });
}

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

function riskContext(over: Partial<RiskContext> = {}): RiskContext {
  const bal: Balance = { currency: 'CAD', total: Money.fromString('1000000'), available: Money.fromString('1000000'), held: Money.zero() };
  return {
    symbol: 'BTC/CAD',
    signal: signal('BTC/CAD', 'BUY'),
    nowMs: 1_000_000,
    marketDataTimestampMs: 1_000_000,
    marketDataObservedAtMs: 1_000_000,
    price: Money.fromString('40000'),
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
    ...over,
  };
}

const intent = { reason: 'test', type: 'limit' as const, price: Money.fromString('40000') };

interface Hooks {
  reserve?: (order: NewOrder) => string | null;
  release?: (order: NewOrder) => void;
}

function buildEngine(exchange: FakeExchange, hooks: Hooks, auth = buyAuth()): LiveOrderEngine {
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate,
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
    controlledLiveAuthorization: auth,
    ...(hooks.reserve ? { reserveManagedQuote: hooks.reserve } : {}),
    ...(hooks.release ? { releaseManagedQuote: hooks.release } : {}),
  });
}

describe('Controlled BUY — engine reservation lifecycle', () => {
  it('reserves before submit and keeps the reservation ACTIVE on an accepted order', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const reserved: string[] = [];
    const released: string[] = [];
    const engine = buildEngine(exchange, {
      reserve: (o) => {
        reserved.push(o.clientOrderId);
        return null;
      },
      release: (o) => released.push(o.clientOrderId),
    });
    const result = await engine.place(riskContext(), intent);
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.order.side).toBe('BUY');
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(reserved).toHaveLength(1);
    // Acknowledged (not terminal): the reservation must remain committed.
    expect(released).toHaveLength(0);
  });

  it('releases the reservation on a DEFINITE exchange rejection', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const released: string[] = [];
    const engine = buildEngine(exchange, {
      reserve: () => null,
      release: (o) => released.push(o.clientOrderId),
    });
    exchange.setFailures({ placeOrder: { kind: 'rejected' } });
    const result = await engine.place(riskContext(), intent);
    expect(result.order.status).toBe('REJECTED');
    expect(released).toHaveLength(1);
  });

  it('KEEPS the reservation ACTIVE on an UNKNOWN/ambiguous submission (no retry)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market }, unknownOrderSubmissions: true });
    const released: string[] = [];
    const engine = buildEngine(exchange, {
      reserve: () => null,
      release: (o) => released.push(o.clientOrderId),
    });
    const result = await engine.place(riskContext(), intent);
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    // Exactly one attempt; the reservation must NOT be released.
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(released).toHaveLength(0);
  });

  it('a failed reservation fails closed BEFORE any exchange contact', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const released: string[] = [];
    const engine = buildEngine(exchange, {
      reserve: () => 'insufficient managed CAD',
      release: (o) => released.push(o.clientOrderId),
    });
    const result = await engine.place(riskContext(), intent);
    expect(result.order.status).toBe('REJECTED');
    expect(result.unknownOutcome).toBe(false);
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(new OrderStore(LEDGER).allOrders().size).toBe(0);
    expect(released).toHaveLength(1);
  });

  it('a throwing reservation fails closed BEFORE any exchange contact', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, {
      reserve: () => {
        throw new Error('reservation backend down');
      },
      release: () => undefined,
    });
    const result = await engine.place(riskContext(), intent);
    expect(result.order.status).toBe('REJECTED');
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('an unresolved live order still blocks a second BUY before reserving', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market }, unknownOrderSubmissions: true });
    let reserveCalls = 0;
    const engine = buildEngine(exchange, {
      reserve: () => {
        reserveCalls += 1;
        return null;
      },
    });
    await engine.place(riskContext(), intent);
    // First order is UNKNOWN; the second is refused by the one-in-flight guard
    // BEFORE the reserve hook is ever invoked.
    await expect(engine.place(riskContext(), intent)).rejects.toThrow(/at most one in-flight live order/);
    expect(reserveCalls).toBe(1);
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('a BUY authorization reaches the NDAX SendOrder boundary (scripted fetch)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const endpoint = href.slice(href.lastIndexOf('/') + 1);
      if (endpoint === 'SendOrder') {
        const body = JSON.parse(String(init?.body));
        // BUY is Side 0, LIMIT is OrderType 2; a limit price is mandatory.
        expect(body.Side).toBe(0);
        expect(body.OrderType).toBe(2);
        expect(body.LimitPrice).toBeGreaterThan(0);
        return new Response(JSON.stringify({ status: 'Accepted', errormsg: '', OrderId: 4242 }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: true, errormsg: '', errorcode: 0, detail: '' }), { status: 200 });
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: 'https://api.ndax.io:8443/AP',
      fetchImpl: fetchImpl as never,
      throttleMs: 0,
      enableAuthenticatedReads: true,
      marketOverrides: { 'BTC/CAD': '1' },
    });
    const order = {
      symbol: 'BTC/CAD' as const,
      side: 'BUY' as const,
      type: 'limit' as const,
      quantity: Money.fromString('0.001'),
      price: Money.fromString('40000'),
      clientOrderId: 'live-x',
      reason: 'test',
    };
    const auth = buyAuth();
    const res = await adapter.placeOrder(order, auth);
    expect(res.exchangeOrderId).toBe('4242');
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('SendOrder'))).toBe(true);

    // Single-use: the same authorization cannot authorize a second order.
    await expect(adapter.placeOrder(order, auth)).rejects.toThrow(/order placement is disabled/);
  });

  it('a BUY authorization still cannot authorize a MARKET order', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'Accepted', errormsg: '', OrderId: 1 }), { status: 200 }));
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: 'https://api.ndax.io:8443/AP',
      fetchImpl: fetchImpl as never,
      throttleMs: 0,
      enableAuthenticatedReads: true,
      marketOverrides: { 'BTC/CAD': '1' },
    });
    await expect(
      adapter.placeOrder(
        { symbol: 'BTC/CAD', side: 'BUY', type: 'market', quantity: Money.fromString('0.001'), clientOrderId: 'live-x', reason: 'test' },
        buyAuth(),
      ),
    ).rejects.toThrow(/order placement is disabled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a SELL authorization can never authorize a BUY at the adapter boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'Accepted', errormsg: '', OrderId: 1 }), { status: 200 }));
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: 'https://api.ndax.io:8443/AP',
      fetchImpl: fetchImpl as never,
      throttleMs: 0,
      enableAuthenticatedReads: true,
      marketOverrides: { 'BTC/CAD': '1' },
    });
    const sellAuth = createControlledLiveAuthorization({
      side: 'SELL',
      type: 'limit',
      maxBaseQuantity: Money.fromString('0.01'),
      maxQuoteNotional: Money.fromString('1000'),
    });
    await expect(
      adapter.placeOrder(
        { symbol: 'BTC/CAD', side: 'BUY', type: 'limit', quantity: Money.fromString('0.001'), price: Money.fromString('40000'), clientOrderId: 'live-x', reason: 'test' },
        sellAuth,
      ),
    ).rejects.toThrow(/order placement is disabled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('SELL (no reservation hook) is unaffected by the BUY reservation plumbing', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.1' }, markets: { 'BTC/CAD': market } });
    const sellAuth = createControlledLiveAuthorization({
      side: 'SELL',
      type: 'limit',
      maxBaseQuantity: Money.fromString('0.01'),
      maxQuoteNotional: Money.fromString('1000'),
    });
    const engine = buildEngine(
      exchange,
      {
        reserve: () => {
          throw new Error('must not be called for SELL');
        },
      },
      sellAuth,
    );
    const ctx = riskContext({ signal: signal('BTC/CAD', 'SELL'), currentPosition: Money.fromString('0.1'), openManagedPositionCount: 1 });
    const result = await engine.place(ctx, intent);
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.order.side).toBe('SELL');
    expect(exchange.submittedOrders).toHaveLength(1);
  });
});
