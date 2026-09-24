/**
 * Managed-state TOCTOU protection at the LIVE submission boundary.
 *
 * The controlled live-test prepares the EXACT order from a managed-state snapshot
 * taken before operator confirmation. Another process could mutate the durable
 * managed state in that window. The engine must, under the EXISTING mutation lock
 * and immediately before any exchange mutation, reload the managed state and
 * re-run the managed-quantity validation against it — failing closed if the
 * approved order is no longer valid, WITHOUT ever resizing/re-pricing/rebuilding
 * or otherwise substituting the approved order.
 *
 * These tests use only a FakeExchange; they never contact a real exchange.
 */

import { describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { ManagedStateStore } from '../../../src/persistence/ManagedStateStore.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { isLockHeld } from '../../../src/persistence/index.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import type { ManagedOrderGuard, PreparedLiveOrder } from '../../../src/execution/LiveExecutionEngine.js';
import { buildManagedOrderGuard } from '../../../src/cli/live-test-cmd.js';
import {
  createControlledLiveAuthorization,
  isControlledLiveAuthorization,
  isControlledLiveOrder,
} from '../../../src/execution/ControlledLiveAuthorization.js';
import type { ControlledLiveAuthorization } from '../../../src/execution/ControlledLiveAuthorization.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { NewOrder } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const SYMBOL = 'BTC/CAD';
const T0 = 1_000_000;

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

function sellCtx(): RiskContext {
  const bal: Balance = {
    currency: 'CAD',
    total: Money.fromString('100000'),
    available: Money.fromString('100000'),
    held: Money.zero(),
  };
  return {
    symbol: SYMBOL,
    signal: signal(SYMBOL, 'SELL'),
    nowMs: T0,
    marketDataTimestampMs: T0,
    marketDataObservedAtMs: T0,
    price: Money.fromString('40000'),
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
    // Bounded target: 400 CAD / 40000 = 0.01 BTC (well within the 0.1 held).
    sellTarget: { notional: Money.fromString('400') },
  };
}

function managedPortfolio(held: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString('100000')]])).applyFill(
    SYMBOL,
    'BUY',
    Money.fromString(held),
    Money.fromString('40000'),
    Money.zero(),
  );
}

interface Setup {
  engine: LiveOrderEngine;
  exchange: FakeExchange;
  live: ManagedStateStore;
  ledger: string;
  dir: string;
  prepared: PreparedLiveOrder;
  ctx: RiskContext;
  auth: ControlledLiveAuthorization;
}

/**
 * A fake that enforces the controlled-authorization boundary like the real NDAX
 * adapter: it consumes the single-use token at SendOrder. Used to prove the new
 * managed-state guard does not bypass/alter the existing single-use semantics.
 */
class AuthConsumingFake extends FakeExchange {
  override async placeOrder(order: NewOrder, authorization?: ControlledLiveAuthorization) {
    if (!isControlledLiveOrder(order, authorization)) {
      throw new Error('order placement is disabled (no valid controlled authorization)');
    }
    return super.placeOrder(order, authorization);
  }
}

function setup(opts: { held?: string; guard?: ManagedOrderGuard; exchange?: FakeExchange } = {}): Setup {
  const ledger = statePath('toctou', 'ledger.json');
  const dir = dirname(ledger);
  const live = new ManagedStateStore(join(dir, 'live.json'));
  live.save(managedPortfolio(opts.held ?? '0.1').stateModel);
  const exchange =
    opts.exchange ??
    new FakeExchange({
      balances: { BTC: '0.1', CAD: '100000' },
      markets: { [SYMBOL]: market },
    });
  exchange.setTicker(SYMBOL, { last: Money.fromString('40000') });
  const store = new OrderStore(ledger);
  const service = new ReconcileService(exchange, store);
  const auth = createControlledLiveAuthorization({
    side: 'SELL',
    type: 'limit',
    maxBaseQuantity: Money.fromString('1'),
    maxQuoteNotional: Money.fromString('100000'),
  });
  const engine = new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate: { tradingMode: 'live', realFundsAtRisk: true },
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('100000'),
    maxLiveBaseQuantity: Money.fromString('1'),
    controlledLiveAuthorization: auth,
    managedOrderGuard: opts.guard ?? buildManagedOrderGuard(live),
  });
  const ctx = sellCtx();
  const prepared = engine.prepare(ctx, { reason: 'toctou-test', type: 'limit', price: Money.fromString('40000') });
  return { engine, exchange, live, ledger, dir, prepared, ctx, auth };
}

describe('LiveExecutionEngine — managed-state TOCTOU guard', () => {
  it('A: unchanged managed state → the exact approved order reaches submission', async () => {
    const { engine, exchange, prepared, ctx } = setup();
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('SUBMITTED');
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(exchange.submittedOrders[0]!.quantity.toFixed(8)).toBe(prepared.order.quantity.toFixed(8));
    expect(exchange.submittedOrders[0]!.price!.toFixed(8)).toBe(prepared.order.price!.toFixed(8));
  });

  it('B: a managed position that no longer covers the approved SELL blocks submission', async () => {
    const { engine, exchange, live, ledger, prepared, ctx } = setup();
    // A concurrent actor reduces the managed position below the approved order.
    live.save(managedPortfolio('0.001').stateModel);
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('REJECTED');
    expect(result.unknownOutcome).toBe(false);
    expect(result.message).toMatch(/no longer covers/);
    expect(exchange.submittedOrders).toHaveLength(0);
    // Nothing was persisted (no CREATED record).
    expect(new OrderStore(ledger).allOrders().size).toBe(0);
  });

  it('C: a managed position that GROWS does not silently resize the approved order', async () => {
    // Managed state grows substantially after preparation; the guard must pass
    // (the order is still covered) and the EXACT approved quantity/price must be
    // submitted — never resized up to the larger position.
    const { engine, exchange, prepared, ctx } = setup({ held: '5' });
    expect(prepared.order.quantity.toFixed(8)).toBe('0.01000000');
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('SUBMITTED');
    expect(exchange.submittedOrders).toHaveLength(1);
    expect(exchange.submittedOrders[0]!.quantity.toFixed(8)).toBe(prepared.order.quantity.toFixed(8));
    expect(exchange.submittedOrders[0]!.price!.toFixed(8)).toBe(prepared.order.price!.toFixed(8));
  });

  it('D: a guard failure cannot resize or reprice the approved order', async () => {
    const { engine, exchange, live, prepared, ctx } = setup();
    live.save(managedPortfolio('0.001').stateModel);
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('REJECTED');
    expect(result.order.quantity.equals(prepared.order.quantity)).toBe(true);
    expect(result.order.price!.equals(prepared.order.price!)).toBe(true);
    expect(result.order.side).toBe(prepared.order.side);
    expect(result.order.symbol).toBe(prepared.order.symbol);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('E: the guard runs under the EXISTING mutation lock, before SendOrder', async () => {
    const ledger = statePath('toctou-lock', 'ledger.json');
    const dir = dirname(ledger);
    const live = new ManagedStateStore(join(dir, 'live.json'));
    live.save(managedPortfolio('0.1').stateModel);
    const exchange = new FakeExchange({ balances: { BTC: '0.1', CAD: '100000' }, markets: { [SYMBOL]: market } });
    exchange.setTicker(SYMBOL, { last: Money.fromString('40000') });

    let guardLockHeld: boolean | null = null;
    let sendOrderLockHeld: boolean | null = null;
    const baseGuard = buildManagedOrderGuard(live);
    const guard: ManagedOrderGuard = (order) => {
      guardLockHeld = isLockHeld(dir);
      return baseGuard(order);
    };
    const store = new OrderStore(ledger);
    const engine = new LiveOrderEngine(exchange, store, new ReconcileService(exchange, store), new RiskManager(riskConfig()), {
      gate: { tradingMode: 'live', realFundsAtRisk: true },
      killSwitch: false,
      maxLiveQuoteNotional: Money.fromString('100000'),
      maxLiveBaseQuantity: Money.fromString('1'),
      controlledLiveAuthorization: createControlledLiveAuthorization({
        side: 'SELL',
        type: 'limit',
        maxBaseQuantity: Money.fromString('1'),
        maxQuoteNotional: Money.fromString('100000'),
      }),
      managedOrderGuard: guard,
    });
    const realPlace = exchange.placeOrder.bind(exchange);
    vi.spyOn(exchange, 'placeOrder').mockImplementation(async (o, a) => {
      sendOrderLockHeld = isLockHeld(dir);
      return realPlace(o, a);
    });

    const ctx = sellCtx();
    const prepared = engine.prepare(ctx, { reason: 'lock', type: 'limit', price: Money.fromString('40000') });
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('SUBMITTED');
    expect(guardLockHeld).toBe(true);
    expect(sendOrderLockHeld).toBe(true);
    // Guard ran before SendOrder.
    expect(exchange.submittedOrders).toHaveLength(1);
    // Lock released afterwards.
    expect(isLockHeld(dir)).toBe(false);
  });

  it('F: a corrupt managed state fails the submission closed', async () => {
    const { engine, exchange, live, prepared, ctx } = setup();
    writeFileSync(live.path, '{ not valid state');
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('REJECTED');
    expect(result.message).toMatch(/corrupt|reconstructed/i);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('G: a missing managed state fails the submission closed', async () => {
    const { engine, exchange, live, prepared, ctx } = setup();
    rmSync(live.path, { force: true });
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('REJECTED');
    expect(result.message).toMatch(/missing/);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('H: the existing controlled authorization remains single-use at the submission boundary', async () => {
    const exchange = new AuthConsumingFake({ balances: { BTC: '0.1', CAD: '100000' }, markets: { [SYMBOL]: market } });
    const { engine, prepared, ctx, auth } = setup({ exchange });
    expect(isControlledLiveAuthorization(auth)).toBe(true);
    const result = await engine.placePrepared(ctx, prepared);
    expect(result.order.status).toBe('SUBMITTED');
    expect(exchange.submittedOrders).toHaveLength(1);
    // The token is consumed at the exchange boundary: a second use is refused.
    expect(isControlledLiveAuthorization(auth)).toBe(false);
    await expect(
      exchange.placeOrder(
        {
          clientOrderId: 'second',
          symbol: SYMBOL,
          side: 'SELL',
          type: 'limit',
          quantity: Money.fromString('0.001'),
          price: Money.fromString('40000'),
          reason: 'reuse',
        },
        auth,
      ),
    ).rejects.toThrow(/order placement is disabled/);
  });
});
