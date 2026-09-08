/**
 * Controlled-LIVE authorization boundary tests.
 *
 * The controlled test is the ONLY path that can reach `adapter.placeOrder()`,
 * and only for SELL + LIMIT with the controlled caps. Everything else must be
 * blocked. These tests verify the engine + adapter gates without ever placing a
 * real order (scripted fetch / FakeExchange only).
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Money } from '../../../src/money/Money.js';
import { botConfigSchema } from '../../../src/config/schema.js';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine, LiveGateError } from '../../../src/execution/LiveExecutionEngine.js';
import {
  createControlledLiveAuthorization,
  isControlledLiveAuthorization,
  isControlledLiveOrder,
} from '../../../src/execution/ControlledLiveAuthorization.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { NewOrder } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('controlled-arm', 'ledger.json');

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

function auth(): ReturnType<typeof createControlledLiveAuthorization> {
  return createControlledLiveAuthorization({
    side: 'SELL',
    type: 'limit',
    maxBaseQuantity: Money.fromString('0.01'),
    maxQuoteNotional: Money.fromString('100'),
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

function riskContext(overrides: Partial<RiskContext> = {}, price = '40000'): RiskContext {
  const bal: Balance = { currency: 'CAD', total: Money.fromString('100000'), available: Money.fromString('100000'), held: Money.zero() };
  return {
    symbol: 'BTC/CAD',
    signal: signal('BTC/CAD', 'SELL'),
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
    currentPosition: Money.fromString('0.1'),
    externalPosition: Money.fromString('0'),
    openManagedPositionCount: 1,
    realizedPnlToday: Money.fromString('0'),
    unrealizedPnlToday: Money.fromString('0'),
    ...overrides,
  };
}

function newOrder(partial: Partial<NewOrder> = {}): NewOrder {
  return {
    symbol: 'BTC/CAD',
    side: 'SELL',
    type: 'limit',
    price: Money.fromString('40000'),
    quantity: Money.fromString('0.001'),
    clientOrderId: 'c1',
    reason: 'test',
    ...partial,
  };
}

function buildEngine(exchange: FakeExchange, extraCfg: Record<string, unknown> = {}): LiveOrderEngine {
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate,
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
    ...extraCfg,
  });
}

/** A scripted NDAX adapter that records SendOrder calls. */
function ndaxAdapter(sendOrder: (body: Record<string, unknown>) => unknown = () => ({ status: 'Accepted', errormsg: '', OrderId: 99 })) {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const endpoint = href.slice(href.lastIndexOf('/') + 1);
    if (endpoint === 'SendOrder') {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(sendOrder(body)), { status: 200 });
    }
    return new Response(JSON.stringify({ result: true, errormsg: '', errorcode: 0, detail: '' }), { status: 200 });
  }) as unknown as ReturnType<typeof vi.fn>;
  const adapter = new NdaxAdapter({
    credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
    baseUrl: 'https://api.ndax.io:8443/AP',
    fetchImpl: fetchImpl as never,
    throttleMs: 0,
    enableAuthenticatedReads: true,
    marketOverrides: { 'BTC/CAD': '1' },
  });
  return { adapter, fetchImpl };
}

describe('Controlled-LIVE authorization — adapter gate', () => {
  it('ordinary NDAX creation cannot place any order (no authorization)', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder({ side: 'SELL', type: 'limit' }))).rejects.toThrow(/order placement is disabled/);
    await expect(adapter.placeOrder(newOrder({ side: 'BUY', type: 'limit' }))).rejects.toThrow(/order placement is disabled/);
  });

  it('an invalid authorization does not allow mutation', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder(), { kind: 'not-a-real-auth' } as never)).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid controlled authorization allows a SELL LIMIT order (SendOrder is reached)', async () => {
    const { adapter, fetchImpl } = ndaxAdapter();
    const res = await adapter.placeOrder(newOrder({ side: 'SELL', type: 'limit' }), auth());
    expect(res.exchangeOrderId).toBe('99');
    // The SendOrder POST actually happened.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: [string]) => String(c[0]).includes('SendOrder'))).toBe(true);
  });

  it('a valid controlled authorization still cannot BUY', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder({ side: 'BUY', type: 'limit' }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid controlled authorization still cannot MARKET', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder({ side: 'SELL', type: 'market' }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('cancelOrder has no controlled-authorization path (requires enableOrderPlacement)', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.cancelOrder('BTC/CAD', '123')).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid authorization cannot authorize a quantity above maxBaseQuantity', async () => {
    const { adapter } = ndaxAdapter();
    // auth() maxBaseQuantity = 0.01; order quantity 0.02 exceeds it.
    await expect(adapter.placeOrder(newOrder({ quantity: Money.fromString('0.02') }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid authorization cannot authorize a quote notional above maxQuoteNotional', async () => {
    const { adapter } = ndaxAdapter();
    // 0.003 * 40000 = 120 > auth() maxQuoteNotional 100.
    await expect(adapter.placeOrder(newOrder({ quantity: Money.fromString('0.003') }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid authorization cannot authorize a zero or negative quantity', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder({ quantity: Money.zero() }), auth())).rejects.toThrow(/order placement is disabled/);
    await expect(adapter.placeOrder(newOrder({ quantity: Money.fromString('-1') }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid authorization cannot authorize a zero or negative price', async () => {
    const { adapter } = ndaxAdapter();
    await expect(adapter.placeOrder(newOrder({ price: Money.zero() }), auth())).rejects.toThrow(/order placement is disabled/);
    await expect(adapter.placeOrder(newOrder({ price: Money.fromString('-1') }), auth())).rejects.toThrow(/order placement is disabled/);
  });

  it('a valid authorization is single-use: it cannot authorize a second order', async () => {
    const { adapter } = ndaxAdapter();
    const a = auth();
    const first = await adapter.placeOrder(newOrder({ side: 'SELL', type: 'limit' }), a);
    expect(first.exchangeOrderId).toBe('99');
    await expect(adapter.placeOrder(newOrder({ side: 'SELL', type: 'limit' }), a)).rejects.toThrow(/order placement is disabled/);
  });
});

describe('Controlled-LIVE authorization — engine gate', () => {
  it('refuses to construct without supportsOrderPlacement or a controlled authorization', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    expect(() => buildEngine(exchange)).toThrow(LiveGateError);
  });

  it('constructs with a valid controlled authorization even when supportsOrderPlacement=false', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    const engine = buildEngine(exchange, { controlledLiveAuthorization: auth() });
    expect(engine).toBeInstanceOf(LiveOrderEngine);
  });

  it('rejects an invalid controlled authorization', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    expect(() => buildEngine(exchange, { controlledLiveAuthorization: { kind: 'nope' } as never })).toThrow(LiveGateError);
  });

  it('rejects a MARKET LIVE intent even with a controlled authorization', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.1' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, { controlledLiveAuthorization: auth() });
    await expect(
      engine.place(riskContext(), { reason: 'test', type: 'market' }),
    ).rejects.toThrow(/NDAX LIVE market orders are disabled/);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('passes a valid controlled authorization through the LiveOrderEngine path successfully', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.1' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    const engine = buildEngine(exchange, { controlledLiveAuthorization: auth() });
    const result = await engine.place(riskContext(), { reason: 'test', type: 'limit', price: Money.fromString('40000') });
    expect(result.order.status).toBe('SUBMITTED');
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(exchange.submittedOrders[0]!.side).toBe('SELL');
    expect(exchange.submittedOrders[0]!.type).toBe('limit');
  });

  it('cannot bypass the trading-mode gate even with a valid controlled authorization', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    expect(() =>
      buildEngine(exchange, {
        gate: { tradingMode: 'paper', realFundsAtRisk: true },
        controlledLiveAuthorization: auth(),
      }),
    ).toThrow(LiveGateError);
  });

  it('cannot bypass the realFundsAtRisk gate even with a valid controlled authorization', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    expect(() =>
      buildEngine(exchange, {
        gate: { tradingMode: 'live', realFundsAtRisk: false },
        controlledLiveAuthorization: auth(),
      }),
    ).toThrow(LiveGateError);
  });

  it('cannot bypass the kill switch even with a valid controlled authorization', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    expect(() =>
      buildEngine(exchange, {
        gate,
        killSwitch: true,
        controlledLiveAuthorization: auth(),
      }),
    ).toThrow(LiveGateError);
  });
});

describe('Controlled-LIVE authorization — factory scope', () => {
  it('only creates a SELL + LIMIT authorization', () => {
    expect(() => createControlledLiveAuthorization({ side: 'BUY', type: 'limit', maxBaseQuantity: Money.fromString('0.01'), maxQuoteNotional: Money.fromString('100') })).toThrow(/SELL-only/);
    expect(() => createControlledLiveAuthorization({ side: 'SELL', type: 'market', maxBaseQuantity: Money.fromString('0.01'), maxQuoteNotional: Money.fromString('100') })).toThrow(/LIMIT-only/);
    expect(() => createControlledLiveAuthorization({ side: 'SELL', type: 'limit', maxBaseQuantity: Money.zero(), maxQuoteNotional: Money.fromString('100') })).toThrow(/positive/);
    const a = auth();
    expect(isControlledLiveAuthorization(a)).toBe(true);
  });

  it('isControlledLiveOrder only accepts a genuine SELL + LIMIT within the authorization scope', () => {
    const order = { side: 'SELL', type: 'limit', quantity: Money.fromString('0.001'), price: Money.fromString('40000') };
    // Positive case consumes the token (single-use).
    expect(isControlledLiveOrder(order, auth())).toBe(true);
    // A consumed token cannot authorize again.
    const a = auth();
    expect(isControlledLiveOrder(order, a)).toBe(true);
    expect(isControlledLiveOrder(order, a)).toBe(false);
    // Rejection cases (each returns false before consuming; fresh auths).
    expect(isControlledLiveOrder({ ...order, side: 'BUY' }, auth())).toBe(false);
    expect(isControlledLiveOrder({ ...order, type: 'market' }, auth())).toBe(false);
    expect(isControlledLiveOrder(order, { kind: 'x' })).toBe(false);
    expect(isControlledLiveOrder(order, { kind: 'controlled-live-test', token: 'x' })).toBe(false);
  });

  it('supportsOrderPlacement semantics remain truthful on the real adapter', async () => {
    const { adapter } = ndaxAdapter();
    expect(adapter.capabilities.supportsOrderPlacement).toBe(false);
  });
});

describe('Controlled-LIVE authorization — anti-forgery (runtime)', () => {
  it('rejects a hand-forged object with the right discriminant/token shape', () => {
    const forged = { kind: 'controlled-live-test', token: 'x' };
    expect(isControlledLiveAuthorization(forged)).toBe(false);
    expect(
      isControlledLiveOrder(
        { side: 'SELL', type: 'limit', quantity: Money.fromString('0.001'), price: Money.fromString('40000') },
        forged,
      ),
    ).toBe(false);
  });

  it('rejects a structural clone whose token is not an issued registry token', () => {
    const real = auth();
    const clone = { kind: real.kind, token: 'forged-clone', scope: real.scope };
    expect(isControlledLiveAuthorization(clone)).toBe(false);
    expect(isControlledLiveAuthorization(real)).toBe(true);
  });

  it('rejects an authorization with a valid-looking UUID that was never issued', () => {
    const forged = {
      kind: 'controlled-live-test',
      token: randomUUID(),
      scope: { side: 'SELL', type: 'limit', maxBaseQuantity: Money.fromString('0.01'), maxQuoteNotional: Money.fromString('100') },
    };
    expect(isControlledLiveAuthorization(forged)).toBe(false);
  });

  it('rejects an authorization with an issued token but malformed/missing scope', () => {
    const real = auth();
    const missingScope = { kind: real.kind, token: real.token };
    expect(isControlledLiveAuthorization(missingScope)).toBe(false);
    const wrongSide = { ...real, scope: { ...real.scope, side: 'BUY' } };
    expect(isControlledLiveAuthorization(wrongSide)).toBe(false);
    const zeroCap = { ...real, scope: { ...real.scope, maxBaseQuantity: Money.zero() } };
    expect(isControlledLiveAuthorization(zeroCap)).toBe(false);
  });

  it('the authorization is single-use at the mutation boundary', () => {
    const a = auth();
    const order = { side: 'SELL', type: 'limit', quantity: Money.fromString('0.001'), price: Money.fromString('40000') };
    expect(isControlledLiveOrder(order, a)).toBe(true);
    expect(isControlledLiveOrder(order, a)).toBe(false);
    // After consumption the token is no longer a valid issued authorization.
    expect(isControlledLiveAuthorization(a)).toBe(false);
  });
});

describe('Controlled-LIVE authorization — controlled-test scope preserved', () => {
  it('one unresolved live order still blocks another', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.1' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange, { controlledLiveAuthorization: auth() });
    await engine.place(riskContext(), { reason: 'first', type: 'limit', price: Money.fromString('40000') });
    await expect(
      engine.place(riskContext(), { reason: 'second', type: 'limit', price: Money.fromString('40000') }),
    ).rejects.toThrow(/at most one in-flight live order/);
    expect(exchange.submittedOrders).toHaveLength(1);
  });
});

describe('Controlled-LIVE authorization — production wiring', () => {
  it('exposes no token-registration bypass or registry', async () => {
    const mod = await import('../../../src/execution/ControlledLiveAuthorization.js');
    const exports = Object.keys(mod);
    expect(exports).toContain('createControlledLiveAuthorization');
    expect(exports).toContain('isControlledLiveAuthorization');
    expect(exports).toContain('isControlledLiveOrder');
    expect(exports).not.toContain('issuedTokens');
    expect(exports).not.toContain('registerToken');
    expect(exports).not.toContain('registry');
  });

  it('has exactly one production call site creating a controlled authorization', () => {
    const root = resolve(import.meta.dirname, '../../../src');
    const callSites: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (entry.name.endsWith('.ts')) {
          const content = readFileSync(p, 'utf8');
          if (content.includes('createControlledLiveAuthorization({')) {
            callSites.push(relative(root, p));
          }
        }
      }
    };
    walk(root);
    expect(callSites).toEqual(['cli/live-test-cmd.ts']);
  });

  it('no config/env schema field can supply or reconstruct the authorization', () => {
    const shape = botConfigSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty('controlledLiveAuthorization');
    expect(shape).not.toHaveProperty('controlledLiveAuth');
    expect(shape).not.toHaveProperty('enableOrderPlacement');
  });
});
