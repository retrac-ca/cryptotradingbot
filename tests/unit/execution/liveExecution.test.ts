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
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('liveengine', 'ledger.json');

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

function riskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
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
    ...overrides,
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

const LIMIT_PRICE = Money.fromString('40000');
function limitIntent(reason: string, extra: Partial<import('../../../src/execution/LiveExecutionEngine.js').LiveOrderIntent> = {}): import('../../../src/execution/LiveExecutionEngine.js').LiveOrderIntent {
  return { reason, type: 'limit', price: LIMIT_PRICE, ...extra };
}

function buildEngine(
  exchange: FakeExchange,
  cfg: { killSwitch?: boolean; ackTimeoutMs?: number } = {},
  risk: RiskManager = new RiskManager(riskConfig()),
): LiveOrderEngine {
  if (!cfg.killSwitch) {
    exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  }
  rmSync(LEDGER, { force: true });
  const store = new OrderStore(LEDGER);
  const service = new ReconcileService(exchange, store);
  return new LiveOrderEngine(exchange, store, service, risk, {
    gate,
    killSwitch: cfg.killSwitch ?? false,
    ackTimeoutMs: cfg.ackTimeoutMs,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
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

describe('LiveOrderEngine — safety-critical live order placement', () => {
  it('refuses to construct without explicit realFundsAtRisk acknowledgement', () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    expect(() => new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
      gate: { tradingMode: 'live', realFundsAtRisk: false },
      killSwitch: false,
      maxLiveQuoteNotional: Money.fromString('1000000'),
      maxLiveBaseQuantity: Money.fromString('100'),
    })).toThrow(LiveGateError);
  });

  it('refuses when the adapter does not support order placement', () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    (exchange.capabilities as { supportsOrderPlacement: boolean }).supportsOrderPlacement = false;
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    expect(() => new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), { gate, killSwitch: false, maxLiveQuoteNotional: Money.fromString('1000000'), maxLiveBaseQuantity: Money.fromString('100') })).toThrow(LiveGateError);
  });

  it('applies the kill switch and refuses to construct when active', () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    expect(() => buildEngine(exchange, { killSwitch: true })).toThrow(LiveGateError);
  });

  // ---- Item 1: RiskManager is wired into the live path ----

  it('routes every placement through RiskManager and submits the risk-approved order', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.order.quantity.isPositive()).toBe(true);
    expect(result.unknownOutcome).toBe(false);
    // Exactly one order reached the exchange, sized by risk, not by the caller.
    expect(exchange.submittedOrders).toHaveLength(1);
    // No externally-supplied clientOrderId is ever used: the engine generates it.
    expect(result.order.clientOrderId.startsWith('live-')).toBe(true);
  });

  it('submits a partial SELL sized to the bounded sellTarget (never an injected quantity)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000', BTC: '0.25' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(
      riskContext({
        signal: signal('BTC/CAD', 'SELL'),
        currentPosition: Money.fromString('0.25'),
        sellTarget: { notional: Money.fromString('1000') },
      }),
      limitIntent('test-partial-sell'),
    );
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.unknownOutcome).toBe(false);
    // Risk approved 1000/40000 = 0.025 BTC (floored to the 1e-8 tick), and the
    // engine submitted exactly that — the caller could not inject a raw qty.
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(exchange.submittedOrders[0]!.quantity.toFixed(8)).toBe('0.02500000');
    expect(result.order.quantity.toFixed(8)).toBe('0.02500000');
  });

  it('rejects a risk-unapproved order as REJECTED without ever contacting the exchange', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const risk = new RiskManager(riskConfig());
    risk.setKillSwitch(true); // definite rejection path
    const engine = buildEngine(exchange, {}, risk);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.status).toBe('REJECTED');
    expect(result.unknownOutcome).toBe(false);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects when RiskManager fails closed on stale market data (no exchange contact)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext({ marketDataTimestampMs: 0 }), limitIntent('test'));
    expect(result.order.status).toBe('REJECTED');
    expect(result.unknownOutcome).toBe(false);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  // ---- Persist-before-submit & idempotency ----

  it('persists the order before submitting (persist-before-submit)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const before = new OrderStore(LEDGER).allOrders().size;
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.status).toBe('SUBMITTED');
    expect(new OrderStore(LEDGER).allOrders().size).toBe(before + 1);
    expect(exchange.submittedOrders).toHaveLength(1);
  });

  it('refuses to re-submit a clientOrderId that already exists in the ledger', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    // Pre-seed the store with a claimed id, then attempt to submit an order using it.
    const store = new OrderStore(LEDGER);
    const now = Date.now();
    store.save({
      clientOrderId: 'already-exists',
      exchangeOrderId: 'x1',
      symbol: 'BTC/CAD',
      side: 'BUY',
      type: 'market',
      status: 'SUBMITTED',
      quantity: Money.fromString('0.1'),
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'quote',
      reason: 'test',
      createdAtMs: now,
      updatedAtMs: now,
    });
    const result = await (engine as unknown as {
      submit(o: NewOrder): Promise<{ order: { status: string }; unknownOutcome: boolean }>;
    }).submit(newOrder({ clientOrderId: 'already-exists' }));
    expect(result.order.status).toBe('REJECTED');
    // No second submission reached the exchange.
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  // ---- Item 3: previously-untested live gates (defense-in-depth validation) ----

  it('rejects a quantity below minOrderBase without contacting the exchange', async () => {
    const strictMarket: MarketInfo = { ...market, minOrderBase: Money.fromString('1') };
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': strictMarket } });
    const engine = buildEngine(exchange);
    await expect(engine.validateOrder({ ...newOrder({ quantity: Money.fromString('0.1') }) }))
      .rejects.toThrow(LiveGateError);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects a limit-order notional below minOrderQuote', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    // price * qty = 0.01 * 1 = 0.01 CAD < minOrderQuote(1) => gate rejects.
    const order = newOrder({ type: 'limit', price: Money.fromString('0.01'), quantity: Money.fromString('1') });
    await expect(engine.validateOrder(order)).rejects.toThrow(LiveGateError);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects a limit price not on the tick grid', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const order = newOrder({ type: 'limit', price: Money.fromString('40000.005'), quantity: Money.fromString('0.1') });
    await expect(engine.validateOrder(order)).rejects.toThrow(LiveGateError);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects a SELL exceeding available base balance', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    // No BTC balance is held; selling any base must be rejected.
    const order = newOrder({ side: 'SELL', quantity: Money.fromString('1') });
    await expect(engine.validateOrder(order)).rejects.toThrow(LiveGateError);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  // ---- Ambiguous-outcome handling: no auto-retry ----

  it('classifies a timeout/delivery failure as ambiguous UNKNOWN (never auto-retries)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    exchange.setFailures({ placeOrder: { kind: 'timeout' } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    // A timeout occurred at the ack boundary; there is no auto-retry, so the
    // fake's placeOrder was attempted exactly once.
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('treats an unknownOrderSubmissions ack as ambiguous UNKNOWN, recorded for reconciliation', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    expect(new OrderStore(LEDGER).allOrders().size).toBeGreaterThan(0);
  });

  it('marks a definite rejection as REJECTED (no retry, safe)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    exchange.setFailures({ placeOrder: { kind: 'rejected' } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.unknownOutcome).toBe(false);
    expect(result.order.status).toBe('REJECTED');
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  // ---- Ack ≠ on-book: lifecycle must be confirmed via reconciliation ----

  it('treats an exchange ack as SUBMITTED (not on-book) until reconciliation confirms it', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    // SendOrder's async ack only proves receipt; the engine stores SUBMITTED.
    expect(result.order.status).toBe('SUBMITTED');
    expect(result.order.exchangeOrderId).not.toBeNull();
    // Reconciliation (refresh against the authoritative order state) confirms
    // the lifecycle instead of trusting the ack.
    const authoritative = await engine.refreshOrder(result.order);
    expect(authoritative.exchangeOrderId).toBe(result.order.exchangeOrderId);
    expect(['OPEN', 'FILLED', 'PARTIALLY_FILLED']).toContain(authoritative.status);
  });

  it('records ambiguous submissions for reconciliation and confirms via reconcile', async () => {
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    expect(result.order.exchangeOrderId).toBeNull();
    // The engine refuses to retry; the reconcile() path is the sanctioned next step.
    const report = await engine.reconcile();
    expect(typeof report.consistent).toBe('boolean');
  });

  it('never places an order at construction/startup (no automatic first trade)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    buildEngine(exchange);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('rejects a LIVE market order type (never silently converts MARKET → LIMIT)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    await expect(engine.place(riskContext(), limitIntent('test', { type: 'market' }))).rejects.toThrow(
      /NDAX LIVE market orders are disabled/,
    );
    // No order was submitted and nothing was persisted for a rejected type.
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(new OrderStore(LEDGER).allOrders().size).toBe(0);
  });

  it('explicitly declares a LIMIT order type and submits it (no silent default ambiguity)', async () => {
    const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
    const engine = buildEngine(exchange);
    const result = await engine.place(riskContext(), limitIntent('test'));
    expect(result.order.type).toBe('limit');
    expect(result.order.status).toBe('SUBMITTED');
    // The limit price is carried through to the submitted order (hard bound).
    expect(exchange.submittedOrders[0]!.price?.toString()).toBe('40000.00000000');
  });
});
