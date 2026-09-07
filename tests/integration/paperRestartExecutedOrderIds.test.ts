/**
 * Regression tests for the P1 persistence/recovery defect:
 *
 *   Before restart, `paper-state.json` contained multiple `executedOrderIds`.
 *   After a restart the portfolio/accounting recovered, but `executedOrderIds`
 *   was dropped (3 -> []) because the fresh `PaperExecutionEngine` started with
 *   an empty in-session `orderHistory`, and `PaperEngine.persist()` derived the
 *   persisted ids from it.
 *
 * These tests simulate a process restart with a fresh execution engine, restore
 * the persisted state, perform a normal persistence/save, and verify the durable
 * executed-order identity is preserved (not re-seeded, not cleared) while the
 * portfolio/accounting remain unchanged. They use isolated disposable temp state.
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../src/money/Money.js';
import { Portfolio } from '../../src/portfolio/Portfolio.js';
import { PaperStateStore } from '../../src/persistence/PaperStateStore.js';
import { PaperExecutionEngine } from '../../src/execution/PaperExecutionEngine.js';
import { PaperEngine } from '../../src/engine/PaperEngine.js';
import { FakeExchange } from '../fakes/FakeExchange.js';
import { buildStrategy } from '../../src/strategy/index.js';
import { buildRiskManager } from '../../src/risk/index.js';
import { botConfigSchema } from '../../src/config/schema.js';
import type { PaperEngineDeps } from '../../src/engine/PaperEngine.js';
import type { PaperExecutionConfig } from '../../src/execution/PaperExecutionTypes.js';
import type { MarketDataProvider, MarketInfo, Ticker, Candle, Timeframe } from '../../src/types.js';
import type { Logger } from '../../src/logging/logger.js';
import { statePath } from '../helpers/state.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '5m';

const silence: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silence,
};

const PAPER_CONFIG: PaperExecutionConfig = {
  feeFraction: 0.0005,
  slippageFraction: 0.0005,
  fillFraction: 1,
};

/** Minimal MarketDataProvider so the engine loop needs no live polling. */
class StubMarketData implements MarketDataProvider {
  readonly symbols = [SYMBOL];
  ticker: Ticker | null = null;
  candles: Candle[] = [];
  getTicker(): Ticker | null {
    return this.ticker;
  }
  getOrderBook() {
    return null;
  }
  getCandles(): Candle[] {
    return this.candles;
  }
  isStale(): boolean {
    return this.ticker === null;
  }
  lastError() {
    return null;
  }
}

function marketInfo(): MarketInfo {
  return {
    symbol: SYMBOL,
    exchangeId: '1001',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 2,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.000001'),
    minOrderQuote: Money.fromString('1'),
    supportsMarketOrders: true,
    feeInfo: { maker: 0.0005, taker: 0.0005, feeCurrency: 'quote' },
  };
}

function cfg() {
  return botConfigSchema.parse({
    exchange: 'ndax',
    tradingPairs: SYMBOL,
    timeframe: TF,
    strategy: 'moving-average-crossover',
    maFastPeriod: 3,
    maSlowPeriod: 5,
    maxPositionSizeFraction: 0.1,
    maxTradeAmount: 0,
    maxPortfolioExposureFraction: 0.5,
    maxDailyLossFraction: 0.05,
    maxDrawdownFraction: 0.1,
    cooldownAfterLossSeconds: 3600,
    paperStartingBalance: 10000,
    paperFeeFraction: 0.0005,
    paperSlippageFraction: 0.0005,
    paperFillFraction: 1,
    evaluateIntervalSeconds: 1,
  });
}

function buildDeps(
  store: PaperStateStore,
  portfolio: Portfolio,
  restoredExecutedOrderIds: string[],
): PaperEngineDeps {
  const c = cfg();
  const exchange = new FakeExchange({ markets: { [SYMBOL]: marketInfo() } });
  const data = new StubMarketData();
  return {
    logger: silence,
    marketData: data,
    exchange,
    strategy: buildStrategy(c),
    riskManager: buildRiskManager(c),
    portfolio,
    store,
    paperConfig: PAPER_CONFIG,
    evaluateIntervalMs: 1000,
    symbols: [SYMBOL],
    timeframe: TF,
    freshnessPolicy: {
      maxQuoteAgeMs: 60000,
      maxTransportAgeMs: 60000,
      maxAcceptableFutureSkewMs: 120000,
    },
    restoredExecutedOrderIds,
  };
}

/** A persisted portfolio holding an open long, matching the observed soak shape. */
function priorPortfolio(): Portfolio {
  let p = Portfolio.empty(new Map([['CAD', Money.fromString('8995.37401347')]]));
  p = p.applyFill(SYMBOL, 'BUY', Money.fromString('0.00900965'), Money.fromString('111002.67'), Money.fromString('0.50004761'));
  return p;
}

describe('Paper persistence/recovery — executedOrderIds survive a restart', () => {
  it('fresh execution engine + save preserves multiple restored executedOrderIds', () => {
    const file = statePath('restart-ids', 'state.json');
    rmSync(file, { force: true });

    // Prior session: open a long + 3 executed orders, persisted.
    const store = new PaperStateStore(file);
    const prior = priorPortfolio();
    const ids = ['paper-a', 'paper-b', 'paper-c'];
    store.save(prior.stateModel, ids);

    // Simulate restart: load the persisted state, reconstruct the portfolio.
    const loaded = store.load();
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') throw new Error('expected OK');
    const portfolio = Portfolio.fromModel(store.toPortfolio(loaded.data)!);

    // Fresh execution engine, restored from durable ids.
    const paper = new PaperExecutionEngine(PAPER_CONFIG, portfolio);
    paper.restoreExecutedOrderIds(loaded.data.executedOrderIds);

    // Normal persistence/save operation (mirrors PaperEngine.persist()).
    store.save(portfolio.stateModel, paper.executedOrderIds);

    // The durable executed-order identity is preserved, not cleared.
    const after = store.load();
    expect(after.status).toBe('OK');
    if (after.status !== 'OK') throw new Error('expected OK');
    expect(after.data.executedOrderIds).toEqual(ids);

    // No reseeding; portfolio/accounting unchanged.
    expect(after.data.cash['CAD']).toBe(prior.stateModel.cash.get('CAD')!.toString());
    expect(after.data.positions[SYMBOL].quantity).toBe('0.00900965');
    expect(after.data.positions[SYMBOL].averageEntryPrice).toBe(
      prior.stateModel.positions.get(SYMBOL)!.averageEntryPrice.toString(),
    );
    expect(after.data.realizedPnl).toBe(prior.stateModel.realizedPnl.toString());
  });

  it('PaperEngine restart (start/stop) persists the restored executedOrderIds intact', async () => {
    const file = statePath('restart-engine', 'state.json');
    rmSync(file, { force: true });

    // Prior session persisted with multiple executed order ids.
    const store = new PaperStateStore(file);
    const prior = priorPortfolio();
    const ids = ['paper-a', 'paper-b', 'paper-c'];
    store.save(prior.stateModel, ids);

    // Restart: load state, reconstruct portfolio, pass restored ids into deps.
    const loaded = store.load();
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') throw new Error('expected OK');
    const portfolio = Portfolio.fromModel(store.toPortfolio(loaded.data)!);

    const deps = buildDeps(store, portfolio, loaded.data.executedOrderIds);
    const engine = new PaperEngine(deps);

    // No in-session orders yet; identity comes only from the restored durable ids.
    expect(engine.orderHistory).toHaveLength(0);

    // Start + graceful stop triggers PaperEngine.persist() (the buggy path).
    await engine.start();
    engine.stop();

    // The durable executed-order identity survived the restart's save.
    const after = store.load();
    expect(after.status).toBe('OK');
    if (after.status !== 'OK') throw new Error('expected OK');
    expect(after.data.executedOrderIds).toEqual(ids);

    // No reseeding; portfolio/accounting unchanged.
    expect(after.data.cash['CAD']).toBe(prior.stateModel.cash.get('CAD')!.toString());
    expect(after.data.positions[SYMBOL].quantity).toBe('0.00900965');
  });

  it('genuinely new state with no executed orders remains valid and persists an empty collection', () => {
    const file = statePath('restart-empty', 'state.json');
    rmSync(file, { force: true });

    const store = new PaperStateStore(file);
    const empty = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    // First-ever init: no executed orders yet.
    store.save(empty.stateModel, []);

    // Restart with no restored ids.
    const loaded = store.load();
    expect(loaded.status).toBe('OK');
    if (loaded.status !== 'OK') throw new Error('expected OK');
    expect(loaded.data.executedOrderIds).toEqual([]);
    expect(loaded.data.cash['CAD']).toBe('10000.00000000');
    expect(Object.keys(loaded.data.positions)).toHaveLength(0);

    const paper = new PaperExecutionEngine(PAPER_CONFIG, empty);
    paper.restoreExecutedOrderIds(loaded.data.executedOrderIds);
    store.save(empty.stateModel, paper.executedOrderIds);

    const after = store.load();
    expect(after.status).toBe('OK');
    if (after.status !== 'OK') throw new Error('expected OK');
    expect(after.data.executedOrderIds).toEqual([]);
    expect(after.data.cash['CAD']).toBe('10000.00000000');
  });
});
