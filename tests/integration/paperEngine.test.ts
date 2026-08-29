import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../src/money/Money.js';
import { Portfolio } from '../../src/portfolio/Portfolio.js';
import { FakeExchange } from '../fakes/FakeExchange.js';
import { PaperEngine } from '../../src/engine/PaperEngine.js';
import { PaperExecutionEngine } from '../../src/execution/PaperExecutionEngine.js';
import type { PaperEngineDeps } from '../../src/engine/PaperEngine.js';
import { buildStrategy } from '../../src/strategy/index.js';
import { buildRiskManager } from '../../src/risk/index.js';
import { RiskManager } from '../../src/risk/index.js';
import { botConfigSchema } from '../../src/config/schema.js';
import { PaperStateStore } from '../../src/persistence/PaperStateStore.js';
import type { MarketDataProvider } from '../../src/marketdata/types.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../src/types.js';
import type { Logger } from '../../src/logging/logger.js';

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

/** A directly-controllable MarketDataProvider so the engine has no polling. */
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
    paperStateFile: '/tmp/opencode/paper-engine-test.json',
    evaluateIntervalSeconds: 1,
  });
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

function candles(closes: number[], nowMs: number): Candle[] {
  return closes.map((close, i) => ({
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: nowMs - (closes.length - i) * 300_000,
    open: Money.fromString(String(close)),
    high: Money.fromString(String(close)),
    low: Money.fromString(String(close)),
    close: Money.fromString(String(close)),
    baseVolume: Money.fromString('1'),
  }));
}

const STATE_FILE = '/tmp/opencode/paper-engine-test.json';

function buildDeps(
  over: {
    store?: PaperStateStore | null;
    portfolio?: Portfolio;
    risk?: RiskManager;
    data?: StubMarketData;
  } = {},
): { deps: PaperEngineDeps; exchange: FakeExchange; data: StubMarketData; risk: RiskManager; portfolio: Portfolio } {
  const c = cfg();
  const exchange = new FakeExchange({ markets: { [SYMBOL]: marketInfo() } });
  const data = over.data ?? new StubMarketData();
  const risk = over.risk ?? buildRiskManager(c);
  const portfolio =
    over.portfolio ??
    (() => {
      const cash = new Map<string, Money>();
      cash.set('CAD', Money.fromString('10000'));
      return Portfolio.empty(cash);
    })();
  const store = over.store === undefined ? new PaperStateStore(STATE_FILE) : over.store;

  const deps: PaperEngineDeps = {
    logger: silence,
    marketData: data,
    exchange,
    strategy: buildStrategy(c),
    riskManager: risk,
    portfolio,
    store,
    paperConfig: {
      feeFraction: c.paperFeeFraction,
      slippageFraction: c.paperSlippageFraction,
      fillFraction: c.paperFillFraction,
    },
    evaluateIntervalMs: 1000,
    symbols: [SYMBOL],
    timeframe: TF,
  };
  return { deps, exchange, data, risk, portfolio };
}

describe('PaperEngine — end-to-end paper trading flow', () => {
  it('runs market data -> strategy -> risk -> paper fill, opening then closing a position', async () => {
    rmSync(STATE_FILE, { force: true });
    const { deps, exchange, data } = buildDeps();
    const engine = new PaperEngine(deps);
    await engine.start();

    const now = 1_000_000;
    // Establish crossState = fast BELOW slow (descending) -> HOLD (no order).
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('14.99'),
      ask: Money.fromString('15.01'),
      last: Money.fromString('15'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: now,
    };
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], now);
    await engine.evaluateOnce(now);
    expect(engine.orderHistory).toHaveLength(0);
    expect(engine.currentPortfolio.position(SYMBOL)).toBeNull();

    // Golden cross -> BUY fill.
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('14.99'),
      ask: Money.fromString('15.01'),
      last: Money.fromString('15'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: now,
    };
    data.candles = candles([10, 11, 12, 13, 14, 15, 16], now);
    await engine.evaluateOnce(now);
    const pos = engine.currentPortfolio.position(SYMBOL);
    expect(pos).not.toBeNull();
    expect(pos!.quantity.isPositive()).toBe(true);
    expect(engine.orderHistory.some((o) => o.status === 'FILLED' && o.side === 'BUY')).toBe(true);

    // Death cross -> SELL closes the long.
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('9.99'),
      ask: Money.fromString('10.01'),
      last: Money.fromString('10'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: now,
    };
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], now);
    await engine.evaluateOnce(now);
    expect(engine.currentPortfolio.position(SYMBOL)).toBeNull();
    expect(engine.orderHistory.some((o) => o.status === 'FILLED' && o.side === 'SELL')).toBe(true);

    // The paper engine must NEVER have contacted the exchange for order placement.
    expect(exchange.submittedOrders).toHaveLength(0);

    engine.stop();
    rmSync(STATE_FILE, { force: true });
  });

  it('risk manager rejects a stale/missing-price signal (no paper order created)', async () => {
    rmSync(STATE_FILE, { force: true });
    const { deps, exchange, data } = buildDeps();
    const engine = new PaperEngine(deps);
    // Lazy market-info load happens on the first evaluation.
    // No ticker at all -> risk cannot price -> no fill.
    data.ticker = null;
    data.candles = candles([10, 11, 12, 13, 14, 15, 16], 1_000_000);
    await engine.evaluateOnce(1_000_000);
    expect(engine.currentPortfolio.position(SYMBOL)).toBeNull();
    expect(engine.orderHistory).toHaveLength(0);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('persists state by default and restores the portfolio from a store on restart', async () => {
    rmSync(STATE_FILE, { force: true });
    const store = new PaperStateStore(STATE_FILE);
    // Simulate a prior session that opened a position and saved it.
    let saved = Portfolio.empty(new Map([['CAD', Money.fromString('9000')]]));
    saved = saved.applyFill(SYMBOL, 'BUY', Money.fromString('0.5'), Money.fromString('2000'), Money.fromString('1'));
    store.save(saved.stateModel, ['prior-order']);

    const { deps, data } = buildDeps({ store, portfolio: saved });
    const engine = new PaperEngine(deps);
    expect(engine.currentPortfolio.position(SYMBOL)!.quantity.toFixed(8)).toBe('0.50000000');

    // Now a death cross should SELL the restored position (not re-buy and not
    // restart at zero). No signal yet at first eval.
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('1999'),
      ask: Money.fromString('2001'),
      last: Money.fromString('2000'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: 2_000_000,
    };
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], 2_000_000);
    await engine.evaluateOnce(2_000_000); // establish state (HOLD)
    await engine.evaluateOnce(2_000_000); // still HOLD
    // Flip to golden to confirm we do not double-trade, then back to death to exit.
    data.candles = candles([10, 11, 12, 13, 14, 15, 16], 2_000_000);
    await engine.evaluateOnce(2_000_000);
    // Since we already hold a position, the golden cross should NOT add (flat-check
    // on BUY) -> still holding.
    expect(engine.currentPortfolio.position(SYMBOL)!.quantity.toFixed(8)).toBe('0.50000000');
    // Death cross now exits.
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], 2_000_000);
    await engine.evaluateOnce(2_000_000);
    expect(engine.currentPortfolio.position(SYMBOL)).toBeNull();
  });

  it('fails closed and continuous operation survives a market-data failure', async () => {
    rmSync(STATE_FILE, { force: true });
    const { deps, data } = buildDeps();
    const engine = new PaperEngine(deps);

    // Getting a golden cross (BUY) works when data is present.
    // Establish fast BELOW slow first (descending) -> HOLD, then flip -> BUY.
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('14.99'),
      ask: Money.fromString('15.01'),
      last: Money.fromString('15'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: 3_000_000,
    };
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], 3_000_000);
    await engine.evaluateOnce(3_000_000); // HOLD (establish state = fast below)
    data.ticker = {
      symbol: SYMBOL,
      bid: Money.fromString('14.99'),
      ask: Money.fromString('15.01'),
      last: Money.fromString('15'),
      open: null,
      high: null,
      low: null,
      baseVolume: null,
      quoteVolume: null,
      timestampMs: 3_000_000,
    };
    data.candles = candles([10, 11, 12, 13, 14, 15, 16], 3_000_000);
    await engine.evaluateOnce(3_000_000); // golden cross -> BUY
    expect(engine.currentPortfolio.position(SYMBOL)).not.toBeNull();

    // Then the data provider starts failing (stale candles / no ticker):
    // the engine must not crash and must not open more exposure.
    data.ticker = null;
    data.candles = [];
    await engine.evaluateOnce(4_000_000);
    expect(engine.currentPortfolio.position(SYMBOL)).not.toBeNull();
    expect(engine.orderHistory.filter((o) => o.side === 'BUY' && o.status === 'FILLED')).toHaveLength(1);
  });

  it('PROOF: paper execution can never invoke live NDAX order placement', async () => {
    rmSync(STATE_FILE, { force: true });
    const { deps, exchange, data } = buildDeps();
    // The exchange's placeOrder (the live order-placement path) must never fire.
    const placeOrderSpy = vi.spyOn(exchange, 'placeOrder');
    const cancelOrderSpy = vi.spyOn(exchange, 'cancelOrder');

    const engine = new PaperEngine(deps);

    // Establish fast-below (descending) then golden-cross (ascending) -> BUY.
    data.ticker = {
      symbol: SYMBOL, bid: Money.fromString('14.99'), ask: Money.fromString('15.01'),
      last: Money.fromString('15'), open: null, high: null, low: null,
      baseVolume: null, quoteVolume: null, timestampMs: 5_000_000,
    };
    data.candles = candles([16, 15, 14, 13, 12, 11, 10], 5_000_000);
    await engine.evaluateOnce(5_000_000); // HOLD (establish state)

    data.candles = candles([10, 11, 12, 13, 14, 15, 16], 5_000_000);
    await engine.evaluateOnce(5_000_000); // golden cross -> BUY

    // A real paper fill happened through the local simulator...
    const buyFills = engine.orderHistory.filter((o) => o.side === 'BUY' && o.status === 'FILLED');
    expect(buyFills).toHaveLength(1);
    expect(engine.currentPortfolio.position(SYMBOL)).not.toBeNull();

    // ...but the live order-placement paths were NEVER touched.
    expect(placeOrderSpy).not.toHaveBeenCalled();
    expect(cancelOrderSpy).not.toHaveBeenCalled();
    expect(exchange.submittedOrders).toHaveLength(0);

    // And the paper execution engine is a separate component that does not even
    // reference the adapter's order methods (it only holds portfolio + config).
    const exec = new PaperExecutionEngine(
      { feeFraction: 0, slippageFraction: 0, fillFraction: 1 },
      engine.currentPortfolio,
    );
    const order = exec.submitMarketOrder(
      {
        clientOrderId: 'x',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'market',
        quantity: Money.fromString('0.001'),
        reason: 'proof',
      },
      { referencePrice: Money.fromString('15'), bid: Money.fromString('14.99'), ask: Money.fromString('15.01') },
      6_000_000,
    );
    expect(order.status).toBe('FILLED');
    expect(placeOrderSpy).not.toHaveBeenCalled();
  });
});
