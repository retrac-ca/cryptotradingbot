/**
 * Gate 7.1 — durable local order identity (LiveOrderEngine).
 *
 * The previous `live-<symbol>-<Date.now()>-<seq>` id was only unique within one
 * process and could regenerate differently across a restart. The new id is a
 * collision-resistant UUID that is generated before submission, persisted as the
 * OrderStore key, survives reload/restart, never changes on `refreshOrder`, and
 * remains stable through an UNKNOWN submission.
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('identity', 'ledger.json');

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
    // Keep each placed order small so several fills on one balance do not
    // deplete the fake account (identity tests are not about sizing).
    maxTradeAmount: Money.fromString('1000'),
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

function riskContext(): RiskContext {
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
  };
}

function buildEngine(exchange: FakeExchange): LiveOrderEngine {
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate,
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
  });
}

const LIMIT_PRICE = Money.fromString('40000');
function limitIntent(reason: string): { reason: string; type: 'limit'; price: Money } {
  return { reason, type: 'limit', price: LIMIT_PRICE };
}

describe('Gate 7.1 — durable order identity', () => {
  it('new orders receive a durable, prefixed, non-empty UUID identity', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    const id = result.order.clientOrderId;
    expect(id).toMatch(/^live-BTCCAD-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Not the legacy restart-unsafe `live-BTCCAD-<ms>-<n>` form.
    expect(id).not.toMatch(/^live-BTCCAD-\d+-\d+$/);
  });

  it('the identity is persisted in the OrderStore and reloaded identically (restart-safe)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    const id = result.order.clientOrderId;
    // A FRESH OrderStore reading the same file simulates a restart.
    const reloaded = new OrderStore(LEDGER).get(id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.clientOrderId).toBe(id);
  });

  it('reloading preserves every non-terminal and terminal order identity', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const r1 = await engine.place(riskContext(), limitIntent('first'));
    await engine.refreshOrder(r1.order); // resolve to terminal so the next order passes the one-in-flight guard
    const r2 = await engine.place(riskContext(), limitIntent('second'));
    const ids = new OrderStore(LEDGER).allOrders();
    expect(ids.has(r1.order.clientOrderId)).toBe(true);
    expect(ids.has(r2.order.clientOrderId)).toBe(true);
    expect(ids.get(r1.order.clientOrderId)!.clientOrderId).toBe(r1.order.clientOrderId);
  });

  it('two concurrently created logical orders cannot collide', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const a = await engine.place(riskContext(), limitIntent('a'));
    await engine.refreshOrder(a.order); // resolve to terminal so b passes the one-in-flight guard
    const b = await engine.place(riskContext(), limitIntent('b'));
    await engine.refreshOrder(b.order); // resolve to terminal so c passes the one-in-flight guard
    expect(a.order.clientOrderId).not.toBe(b.order.clientOrderId);
    // Distinct across restarts too.
    const third = new LiveOrderEngine(
      exchange,
      new OrderStore(LEDGER),
      new ReconcileService(exchange, new OrderStore(LEDGER)),
      new RiskManager(riskConfig()),
      { gate, killSwitch: false, maxLiveQuoteNotional: Money.fromString('1000000'), maxLiveBaseQuantity: Money.fromString('100') },
    );
    const c = await third.place(riskContext(), limitIntent('c'));
    expect(c.order.clientOrderId).not.toBe(a.order.clientOrderId);
    expect(c.order.clientOrderId).not.toBe(b.order.clientOrderId);
  });

  it('refreshOrder does not change the logical identity', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    const id = result.order.clientOrderId;
    const authoritative = await engine.refreshOrder(result.order);
    expect(authoritative.clientOrderId).toBe(id);
  });

  it('an UNKNOWN submission retains the same identity across reload and refresh', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.status).toBe('UNKNOWN');
    const id = result.order.clientOrderId;
    expect(result.order.exchangeOrderId).toBeNull();
    // Reload keeps the identity.
    expect(new OrderStore(LEDGER).get(id)!.clientOrderId).toBe(id);
    // refreshOrder with no exchangeOrderId returns the order unchanged (same id).
    const r = await engine.refreshOrder(result.order);
    expect(r.clientOrderId).toBe(id);
  });
});
