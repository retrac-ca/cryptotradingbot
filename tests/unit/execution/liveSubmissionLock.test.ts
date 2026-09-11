/**
 * P2-3 — cross-process atomicity of the LIVE submission critical section.
 *
 * The LIVE submission path (unresolved-order guard → validate → persist CREATED
 * → exchange SendOrder → persist result) must be atomic ACROSS PROCESSES, so two
 * concurrent `bot live-test` invocations cannot both observe "no unresolved LIVE
 * order" and both reach SendOrder.
 *
 * The implementation holds the existing state-directory mutation lock (the SAME
 * canonical `.mutation.lock`) across the whole async critical section via
 * `withStateDirLockAsync`. These tests prove:
 *   - the lock is acquired BEFORE the guard and held ACROSS the placement call;
 *   - an externally-held lock fails the submission closed before the guard;
 *   - two independent module contexts (separate `heldByProcess` reentrancy sets,
 *     i.e. faithful separate-process simulation) contend on the same lock file;
 *   - two independent engine contexts racing a LIVE submission produce exactly
 *     one exchange placement and exactly one durable unresolved order;
 *   - the guard observes durable state written after engine construction (TOCTOU);
 *   - the lock is released on validation/placement failure.
 *
 * They NEVER contact a real exchange (FakeExchange only).
 *
 * LIMITATION OF THE SIMULATION: separate module instances share the process's
 * event loop, so this proves FILESYSTEM-arbitrated mutual exclusion between
 * independent lock owners (which is exactly what separates processes); it does
 * not additionally prove scheduling isolation across OS processes.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import { withStateDirLockAsync, isLockHeld } from '../../../src/persistence/index.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { Order } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

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

function limitIntent(reason: string): import('../../../src/execution/LiveExecutionEngine.js').LiveOrderIntent {
  return { reason, type: 'limit', price: Money.fromString('40000') };
}

function unresolvedOrder(clientOrderId: string): Order {
  const now = Date.now();
  return {
    clientOrderId,
    exchangeOrderId: null,
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'limit',
    status: 'SUBMITTED',
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: Money.fromString('40000'),
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test-unresolved',
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function buildEngineWithStore(exchange: FakeExchange, ledger: string): { engine: LiveOrderEngine; store: OrderStore } {
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  const store = new OrderStore(ledger);
  const service = new ReconcileService(exchange, store);
  const engine = new LiveOrderEngine(exchange, store, service, new RiskManager(riskConfig()), {
    gate: { tradingMode: 'live', realFundsAtRisk: true },
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
  });
  return { engine, store };
}

function freshExchange(): FakeExchange {
  const exchange = new FakeExchange({ balances: { CAD: '100000' }, markets: { 'BTC/CAD': market } });
  exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
  return exchange;
}

/**
 * A generation of modules with its OWN `heldByProcess` reentrancy set. Loading a
 * second generation after `vi.resetModules()` faithfully models a separate
 * process for lock arbitration: the two generations share ONLY the filesystem.
 */
interface Generation {
  engineMod: typeof import('../../../src/execution/LiveExecutionEngine.js');
  storeMod: typeof import('../../../src/persistence/OrderStore.js');
  riskMod: typeof import('../../../src/risk/RiskManager.js');
  reconMod: typeof import('../../../src/reconcile/ReconcileService.js');
  lockMod: typeof import('../../../src/persistence/lock.js');
}

async function loadGeneration(): Promise<Generation> {
  vi.resetModules();
  const [engineMod, storeMod, riskMod, reconMod, lockMod] = await Promise.all([
    import('../../../src/execution/LiveExecutionEngine.js'),
    import('../../../src/persistence/OrderStore.js'),
    import('../../../src/risk/RiskManager.js'),
    import('../../../src/reconcile/ReconcileService.js'),
    import('../../../src/persistence/lock.js'),
  ]);
  return { engineMod, storeMod, riskMod, reconMod, lockMod };
}

function buildGenerationEngine(
  gen: Generation,
  exchange: FakeExchange,
  ledger: string,
): import('../../../src/execution/LiveExecutionEngine.js').LiveOrderEngine {
  const store = new gen.storeMod.OrderStore(ledger);
  const service = new gen.reconMod.ReconcileService(exchange, store);
  const risk = new gen.riskMod.RiskManager(riskConfig());
  return new gen.engineMod.LiveOrderEngine(exchange, store, service, risk, {
    gate: { tradingMode: 'live', realFundsAtRisk: true },
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
  });
}

describe('P2-3 — LIVE submission lock: cross-process critical section', () => {
  it('E: the lock is held ACROSS the exchange placement call and released afterwards', async () => {
    const ledger = statePath('submission-span', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = freshExchange();
    const { engine } = buildEngineWithStore(exchange, ledger);

    let heldDuringPlace = false;
    const realPlace = exchange.placeOrder.bind(exchange);
    vi.spyOn(exchange, 'placeOrder').mockImplementation(async (o, a) => {
      heldDuringPlace = isLockHeld(dir);
      return realPlace(o, a);
    });

    const result = await engine.place(riskContext(), limitIntent('span'));
    expect(result.order.status).toBe('SUBMITTED');
    expect(heldDuringPlace).toBe(true);
    expect(isLockHeld(dir)).toBe(false);
  });

  it('F: an externally-held lock fails the submission closed BEFORE the guard or exchange', async () => {
    const ledger = statePath('submission-external', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = freshExchange();
    const { engine, store } = buildEngineWithStore(exchange, ledger);

    // Simulate a SEPARATE process holding the state-directory lock.
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, '.mutation.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAtMs: Date.now() }));

    const allOrders = vi.spyOn(store, 'allOrders');
    await expect(engine.place(riskContext(), limitIntent('blocked'))).rejects.toThrow(/lock is held/);
    // The lock is acquired BEFORE the unresolved-order guard runs.
    expect(allOrders).not.toHaveBeenCalled();
    expect(exchange.submittedOrders).toHaveLength(0);
    // No stale-lock stealing: the external lock is left exactly where it was.
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { force: true });
  });

  it('C: the guard runs under the lock and observes durable state written after construction (TOCTOU)', async () => {
    const ledger = statePath('submission-toctou', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = freshExchange();
    const { engine, store } = buildEngineWithStore(exchange, ledger);

    let lockHeldDuringGuard: boolean | null = null;
    const realAllOrders = store.allOrders.bind(store);
    vi.spyOn(store, 'allOrders').mockImplementation(() => {
      lockHeldDuringGuard = isLockHeld(dir);
      return realAllOrders();
    });

    // A DIFFERENT process establishes an unresolved LIVE order AFTER the engine
    // was constructed. A stale pre-lock snapshot would miss it.
    new OrderStore(ledger).save(unresolvedOrder('live-other-process-1'));

    await expect(engine.place(riskContext(), limitIntent('toctou'))).rejects.toThrow(/unresolved LIVE order/);
    expect(lockHeldDuringGuard).toBe(true);
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(isLockHeld(dir)).toBe(false);
  });

  it('D: the lock is released when validation throws (no stuck lock)', async () => {
    const ledger = statePath('submission-exc-validate', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = freshExchange();
    exchange.setFailures({ getMarketInfo: { kind: 'network' } });
    const { engine } = buildEngineWithStore(exchange, ledger);

    await expect(engine.place(riskContext(), limitIntent('exc'))).rejects.toThrow();
    expect(exchange.submittedOrders).toHaveLength(0);
    expect(isLockHeld(dir)).toBe(false);
    // The lock is not stuck: a subsequent acquisition succeeds.
    await expect(withStateDirLockAsync(dir, async () => 'ok')).resolves.toBe('ok');
  });

  it('D2: an ambiguous placement outcome still fails closed and releases the lock', async () => {
    const ledger = statePath('submission-exc-ambiguous', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = new FakeExchange({
      balances: { CAD: '100000' },
      markets: { 'BTC/CAD': market },
      unknownOrderSubmissions: true,
    });
    exchange.setTicker('BTC/CAD', { last: Money.fromString('40000') });
    const { engine } = buildEngineWithStore(exchange, ledger);

    const result = await engine.place(riskContext(), limitIntent('exc2'));
    expect(result.unknownOutcome).toBe(true);
    expect(result.order.status).toBe('UNKNOWN');
    expect(isLockHeld(dir)).toBe(false);
  });

  it('G: two independent module contexts contend on the same lock file (cross-process arbitration)', async () => {
    const dir = statePath('submission-crosslock', 'ledger.json');
    const genA = await loadGeneration();
    const genB = await loadGeneration();

    let releaseA!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let acquiredA!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquiredA = resolve;
    });

    const a = genA.lockMod.withStateDirLockAsync(dir, async () => {
      acquiredA();
      await held;
      return 'A';
    });
    await ready;
    // Observe from generation A's own module context: A is the owner that
    // acquired the lock, so A's lock module is the correct observer here
    // (the top-level import belongs to a different module generation).
    expect(genA.lockMod.isLockHeld(dir)).toBe(true);

    // A genuinely separate lock owner cannot enter while A holds it.
    await expect(genB.lockMod.withStateDirLockAsync(dir, async () => 'B')).rejects.toMatchObject({
      name: 'StateLockedError',
    });
    // Nor can it bypass the lock with a differently-normalized form of the SAME
    // directory (trailing slash / `/.`).
    await expect(genB.lockMod.withStateDirLockAsync(`${dir}/`, async () => 'B')).rejects.toMatchObject({
      name: 'StateLockedError',
    });
    await expect(genB.lockMod.withStateDirLockAsync(`${dir}/./`, async () => 'B')).rejects.toMatchObject({
      name: 'StateLockedError',
    });

    releaseA();
    await expect(a).resolves.toBe('A');
    expect(genA.lockMod.isLockHeld(dir)).toBe(false);
    // Once released, the second context may acquire.
    await expect(genB.lockMod.withStateDirLockAsync(dir, async () => 'B2')).resolves.toBe('B2');
  });

  it('A: two independent LIVE submission contexts race — exactly one reaches SendOrder', async () => {
    const ledger = statePath('submission-race', 'ledger.json');
    const dir = dirname(ledger);
    const exchange = freshExchange();
    const genA = await loadGeneration();
    const genB = await loadGeneration();
    const engineA = buildGenerationEngine(genA, exchange, ledger);
    const engineB = buildGenerationEngine(genB, exchange, ledger);

    const [resA, resB] = await Promise.allSettled([
      engineA.place(riskContext(), limitIntent('race-A')),
      engineB.place(riskContext(), limitIntent('race-B')),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
    const rejected = [resA, resB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ name: 'StateLockedError' });

    // Exactly one order reached the exchange mock...
    expect(exchange.submittedOrders).toHaveLength(1);
    // ...and exactly one unresolved LIVE order was durably created.
    const orders = new OrderStore(ledger).allOrders();
    expect(orders.size).toBe(1);
    expect([...orders.values()][0]!.status).toBe('SUBMITTED');
    expect(isLockHeld(dir)).toBe(false);
  });
});
