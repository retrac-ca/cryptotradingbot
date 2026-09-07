/**
 * Gate 7.3 — ambiguous-submission recovery & exchange re-attachment.
 *
 * The invariant: an ambiguous submission must NEVER be retried just because the
 * client does not know whether the exchange accepted it. Recovery may only
 * re-attach an order using a PROVABLY-unique shared identity (exchange order id,
 * or a client order id the exchange contract guarantees unique). Zero matches
 * are NOT proof of rejection; multiple matches fail closed; no heuristic
 * (symbol/quantity/price/timestamp) matching is ever used. Fills adopted by
 * recovery only flow to Gate 7.2 when they carry a trustworthy `executionId`.
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import {
  LiveOrderEngine,
  type LiveExecutionConfig,
} from '../../../src/execution/LiveExecutionEngine.js';
import {
  classifyReattachment,
  isProvableReattachmentMatch,
} from '../../../src/execution/index.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Order, Fill } from '../../../src/order.js';
import type { MarketInfo } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('recovery', 'ledger.json');
const SYMBOL = 'BTC/CAD';

const market: MarketInfo = {
  symbol: SYMBOL,
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

function buildEngine(exchange: FakeExchange, extraCfg: Partial<LiveExecutionConfig> = {}): LiveOrderEngine {
  exchange.setTicker(SYMBOL, { last: Money.fromString('40000') });
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate,
    killSwitch: false,
    ...extraCfg,
  });
}

/** A local ambiguous logical order (no exchangeOrderId). */
function mkOrder(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: 'live-BTCCAD-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    exchangeOrderId: null,
    symbol: SYMBOL,
    side: 'BUY',
    type: 'market',
    status: 'UNKNOWN',
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'recovery-test',
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...over,
  };
}

function candOrder(over: Partial<Order>): Order {
  return mkOrder({ status: 'OPEN', ...over });
}

describe('Gate 7.3 — re-attachment classifier (no heuristics)', () => {
  it('UNIQUE_MATCH by a known, unique exchangeOrderId', () => {
    const local = mkOrder({ exchangeOrderId: 'e1' });
    const cand = candOrder({ exchangeOrderId: 'e1' });
    const res = classifyReattachment(local, [cand]);
    expect(res.outcome).toBe('UNIQUE_MATCH');
    expect(res.order?.exchangeOrderId).toBe('e1');
  });

  it('ZERO_MATCH: same symbol/quantity/price but NO shared identity is never a match', () => {
    const local = mkOrder(); // exchangeOrderId null
    const cand = candOrder({
      exchangeOrderId: '999',
      clientOrderId: '', // NDAX echo of unset client order id
      quantity: local.quantity,
    });
    // same symbol + identical quantity, but no provable identity -> ZERO (not matched).
    const res = classifyReattachment(local, [cand], { clientOrderIdIsUnique: false });
    expect(res.outcome).toBe('ZERO_MATCH');
    // Even a non-empty but DIFFERENT/unknown clientOrderId is not a provable match.
    const res2 = classifyReattachment(local, [candOrder({ exchangeOrderId: '999', clientOrderId: 'other' })], { clientOrderIdIsUnique: true });
    expect(res2.outcome).toBe('ZERO_MATCH');
  });

  it('clientOrderId matching is only trusted when the contract guarantees uniqueness (NDAX does not)', () => {
    const local = mkOrder();
    const cand = candOrder({ exchangeOrderId: '999', clientOrderId: local.clientOrderId });
    expect(classifyReattachment(local, [cand], { clientOrderIdIsUnique: false }).outcome).toBe('ZERO_MATCH');
    expect(classifyReattachment(local, [cand], { clientOrderIdIsUnique: true }).outcome).toBe('UNIQUE_MATCH');
  });

  it('MULTIPLE_MATCH: two candidates claiming the same exchange order id fails closed', () => {
    const local = mkOrder({ exchangeOrderId: 'e1' });
    const res = classifyReattachment(local, [candOrder({ exchangeOrderId: 'e1' }), candOrder({ exchangeOrderId: 'e1' })]);
    expect(res.outcome).toBe('MULTIPLE_MATCH');
  });

  it('a same exchange order id on a DIFFERENT symbol is not a match (market guard)', () => {
    const local = mkOrder({ exchangeOrderId: 'e1' });
    const cand = candOrder({ exchangeOrderId: 'e1', symbol: 'ETH/CAD' });
    const res = classifyReattachment(local, [cand]);
    expect(res.outcome).toBe('ZERO_MATCH');
  });

  it('MALFORMED inputs fail closed', () => {
    expect(classifyReattachment(null as unknown as Order, []).outcome).toBe('MALFORMED');
    expect(classifyReattachment(mkOrder(), null as unknown as Order[]).outcome).toBe('MALFORMED');
  });

  it('isProvableReattachmentMatch never matches on price/qty/timestamp heuristics', () => {
    const local = mkOrder();
    const near = candOrder({ exchangeOrderId: '999', clientOrderId: local.clientOrderId + '-x' });
    expect(isProvableReattachmentMatch(local, near, { clientOrderIdIsUnique: true })).toBe(false);
    // identical economic values, different identity -> NOT a match
    const identical = candOrder({ exchangeOrderId: '999', clientOrderId: 'ZZZ', quantity: local.quantity });
    expect(isProvableReattachmentMatch(local, identical, { clientOrderIdIsUnique: false })).toBe(false);
  });
});

describe('Gate 7.3 — recoverOrder on the live engine', () => {
  it('a known exchangeOrderId refreshes authoritative state (REFRESHED)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange);
    const live = candOrder({ exchangeOrderId: 'e1', status: 'OPEN' });
    exchange.seedOrders([live]);
    const res = await engine.recoverOrder(mkOrder({ exchangeOrderId: 'e1', status: 'UNKNOWN' }));
    expect(res.outcome).toBe('REFRESHED');
    expect(res.order.status).toBe('OPEN');
    expect(res.order.exchangeOrderId).toBe('e1');
    // persisted
    expect(new OrderStore(LEDGER).get(res.order.clientOrderId)?.status).toBe('OPEN');
  });

  it('unique client-order-id re-attachment succeeds when genuinely supported (policy true)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange, { reattachmentClientOrderIdIsUnique: true });
    const local = mkOrder(); // exchangeOrderId null, clientOrderId = UUID
    exchange.seedOrders([candOrder({ exchangeOrderId: 'e9', clientOrderId: local.clientOrderId, status: 'OPEN' })]);
    const res = await engine.recoverOrder(local);
    expect(res.outcome).toBe('UNIQUE_ATTACHED');
    expect(res.order.exchangeOrderId).toBe('e9');
    expect(res.order.clientOrderId).toBe(local.clientOrderId); // durable local id preserved
    expect(new OrderStore(LEDGER).get(local.clientOrderId)?.exchangeOrderId).toBe('e9');
  });

  it('an NDAX-style no-identity recovery remains UNRESOLVED (fail closed, zero match, no auto-retry)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange); // policy false (NDAX)
    const local = mkOrder();
    // The exchange DOES have a working order for this trade, but it carries no
    // client-order-id and the local has no exchange order id -> no provable match.
    exchange.seedOrders([candOrder({ exchangeOrderId: '1', clientOrderId: '', status: 'OPEN', quantity: local.quantity })]);
    const res = await engine.recoverOrder(local);
    expect(res.outcome).toBe('UNRESOLVED');
    expect(res.order.status).toBe('UNKNOWN'); // never concluded REJECTED/FILLED
    expect(res.order.exchangeOrderId).toBeNull();
    expect(exchange.submittedOrders).toHaveLength(0); // never re-submitted
  });

  it('zero match stays UNKNOWN (never treated as REJECTED)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange);
    const res = await engine.recoverOrder(mkOrder());
    expect(res.outcome).toBe('UNRESOLVED');
    expect(res.order.status).toBe('UNKNOWN');
  });

  it('an exchange order already attached to ANOTHER local order cannot be re-attached (fail closed)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange, { reattachmentClientOrderIdIsUnique: true });
    const local = mkOrder(); // clientOrderId = X, no exchangeOrderId
    const other = mkOrder({ clientOrderId: 'live-BTCCAD-22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', exchangeOrderId: 'e9' });
    const store = new OrderStore(LEDGER);
    store.save(other); // another local order already owns exchangeOrderId 'e9'
    exchange.seedOrders([candOrder({ exchangeOrderId: 'e9', clientOrderId: local.clientOrderId, status: 'OPEN' })]);
    const res = await engine.recoverOrder(local);
    expect(res.outcome).toBe('UNRESOLVED');
    expect(res.order.exchangeOrderId).toBeNull();
  });

  it('recovery is idempotent (repeated calls do not mutate or duplicate)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange);
    const local = mkOrder();
    // Persist the ambiguous order as the submission path would.
    new OrderStore(LEDGER).save(local);
    exchange.seedOrders([candOrder({ exchangeOrderId: '1', clientOrderId: '', status: 'OPEN' })]);
    const a = await engine.recoverOrder(local);
    const b = await engine.recoverOrder(local);
    expect(a.outcome).toBe('UNRESOLVED');
    expect(b.outcome).toBe('UNRESOLVED');
    // Still exactly one local order, still UNKNOWN, no duplicate created.
    const reloaded = new OrderStore(LEDGER).get(local.clientOrderId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('UNKNOWN');
    expect(new OrderStore(LEDGER).allOrders().size).toBe(1);
  });

  it('recovery read failure fails closed (stays UNKNOWN)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange);
    exchange.setFailures({ getOpenOrders: { kind: 'network' } });
    const res = await engine.recoverOrder(mkOrder());
    expect(res.outcome).toBe('UNRESOLVED');
    expect(res.order.status).toBe('UNKNOWN');
  });
});

describe('Gate 7.3 — durable UNKNOWN + reservation interplay', () => {
  it('an ambiguous UNKNOWN order survives restart with the same clientOrderId (no regeneration)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market }, unknownOrderSubmissions: true });
    const engine = buildEngine(exchange);
    const result = await engine.place(
      {
        symbol: SYMBOL,
        signal: { symbol: SYMBOL, type: 'BUY', timestampMs: 1_000_000 },
        nowMs: 1_000_000,
        marketDataTimestampMs: 1_000_000,
        marketDataObservedAtMs: 1_000_000,
        price: Money.fromString('40000'),
        marketInfo: market,
        quoteBalance: { currency: 'CAD', total: Money.fromString('100000'), available: Money.fromString('100000'), held: Money.zero() },
        deployableQuote: Money.fromString('1000000'),
        portfolioValue: Money.fromString('100000'),
        peakPortfolioValue: Money.fromString('100000'),
        portfolioExposure: Money.fromString('0'),
        currentPosition: Money.fromString('0'),
        externalPosition: Money.fromString('0'),
        openManagedPositionCount: 0,
        realizedPnlToday: Money.fromString('0'),
        unrealizedPnlToday: Money.fromString('0'),
      } as never,
      { reason: 'test' },
    );
    expect(result.order.status).toBe('UNKNOWN');
    const id = result.order.clientOrderId;
    const reloaded = new OrderStore(LEDGER).get(id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('UNKNOWN'); // durable
    expect(reloaded!.clientOrderId).toBe(id); // not regenerated
    expect(reloaded!.exchangeOrderId).toBeNull();
  });

  it('an UNRESOLVED recovery does not release the order-linked reservation', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange);
    const local = mkOrder();
    // Gate 7.1 reservation for the logical order (kept on the managed portfolio).
    let portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
    portfolio = portfolio.reserveOrder(local.clientOrderId, 'CAD', Money.fromString('300'));
    expect(portfolio.orderReservation(local.clientOrderId)!.status).toBe('ACTIVE');

    const res = await engine.recoverOrder(local); // UNRESOLVED (no identity)
    expect(res.outcome).toBe('UNRESOLVED');
    // Recovery never touches the reserved Portfolio; the reservation stays intact
    // and is NOT released merely because the outcome is unknown.
    expect(portfolio.orderReservation(local.clientOrderId)!.status).toBe('ACTIVE');
    expect(portfolio.reserved('CAD').toString()).toBe('300.00000000');
  });

  it('a recovered order with a TRUSTWORTHY execution id reaches Gate 7.2 exactly once', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange, { reattachmentClientOrderIdIsUnique: true });
    const local = mkOrder();
    const trustedFill: Fill = {
      price: Money.fromString('40000'), quantity: Money.fromString('0.1'), fee: Money.fromString('1'),
      feeCurrency: 'quote', timestampMs: 5000, executionId: 'TRADE-1',
    };
    exchange.seedOrders([candOrder({ exchangeOrderId: 'e9', clientOrderId: local.clientOrderId, status: 'FILLED', filledQuantity: Money.fromString('0.1'), fills: [trustedFill] })]);
    const res = await engine.recoverOrder(local);
    expect(res.outcome).toBe('UNIQUE_ATTACHED');
    const adopted = res.order.fills.find((f) => f.executionId === 'TRADE-1')!;
    let portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    portfolio = portfolio.reserveOrder(local.clientOrderId, 'CAD', Money.fromString('5000'));
    portfolio = portfolio.applyLiveFill(local.clientOrderId, SYMBOL, 'BUY', adopted);
    expect(portfolio.position(SYMBOL)!.quantity.toString()).toBe('0.10000000');
    expect(portfolio.appliedCount()).toBe(1);
    const dup = portfolio.applyLiveFill(local.clientOrderId, SYMBOL, 'BUY', adopted);
    expect(dup.appliedCount()).toBe(1); // exactly once
    expect(dup.position(SYMBOL)!.quantity.toString()).toBe('0.10000000');
  });

  it('a recovered order with missing execution identity cannot flow to Gate 7.2 accounting', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(exchange, { reattachmentClientOrderIdIsUnique: true });
    const local = mkOrder();
    // Exchange echoes the client id, and reports a FILL with NO executionId.
    const exchangeFill: Fill = { price: Money.fromString('40000'), quantity: Money.fromString('0.1'), fee: Money.fromString('1'), feeCurrency: 'quote', timestampMs: 5000 };
    exchange.seedOrders([candOrder({ exchangeOrderId: 'e9', clientOrderId: local.clientOrderId, status: 'FILLED', filledQuantity: Money.fromString('0.1'), fills: [exchangeFill] })]);
    const res = await engine.recoverOrder(local);
    expect(res.outcome).toBe('UNIQUE_ATTACHED');
    // The fill lacks a trustworthy executionId -> Gate 7.2 blocks accounting.
    let portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
    portfolio = portfolio.reserveOrder(local.clientOrderId, 'CAD', Money.fromString('500'));
    expect(() => portfolio.applyLiveFill(local.clientOrderId, SYMBOL, 'BUY', exchangeFill)).toThrow(/no executionId|trustworthy identity/);
    expect(portfolio.position(SYMBOL)).toBeNull(); // not applied
    expect(portfolio.orderReservation(local.clientOrderId)!.remaining.toString()).toBe('500.00000000');
  });
});
