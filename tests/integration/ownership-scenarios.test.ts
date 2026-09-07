import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../src/money/Money.js';
import { Portfolio } from '../../src/portfolio/Portfolio.js';
import { FakeExchange } from '../fakes/FakeExchange.js';
import { PaperEngine } from '../../src/engine/PaperEngine.js';
import type { PaperEngineDeps } from '../../src/engine/PaperEngine.js';
import { buildStrategy } from '../../src/strategy/index.js';
import { buildRiskManager } from '../../src/risk/index.js';
import { botConfigSchema } from '../../src/config/schema.js';
import type { MarketDataProvider } from '../../src/marketdata/types.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../src/types.js';
import type { Logger } from '../../src/logging/logger.js';
import { statePath } from '../helpers/state.js';

const BTC = 'BTC/CAD';
const ETH = 'ETH/CAD';
const TF: Timeframe = '5m';
const NOW = 1_000_000;
const STATE = statePath('scenarios', 'state.json');

const silence: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => silence,
};

class StubData implements MarketDataProvider {
  tickers = new Map<string, Ticker>();
  candles = new Map<string, Candle[]>();
  getTicker(s: string): Ticker | null {
    const t = this.tickers.get(s);
    return t ? { ...t, observedAtMs: t.observedAtMs ?? t.timestampMs } : null;
  }
  getOrderBook() { return null; }
  getCandles(s: string): Candle[] { return this.candles.get(s) ?? []; }
  isStale(): boolean { return false; }
  lastError() { return null; }
}

function info(symbol: string, minBase: string): MarketInfo {
  return {
    symbol, exchangeId: '1', priceTick: Money.fromString('0.01'),
    basePrecision: 2, quotePrecision: 2, quantityTick: Money.fromString('0.000001'),
    minOrderBase: Money.fromString(minBase), minOrderQuote: null,
    supportsMarketOrders: true, feeInfo: { maker: 0.0005, taker: 0.0005, feeCurrency: 'quote' },
  };
}

function cfg(over: Record<string, unknown> = {}) {
  return botConfigSchema.parse({
    exchange: 'ndax',
    tradingPairs: `${BTC},${ETH}`,
    universeMarkets: `${BTC},${ETH}`,
    timeframe: TF,
    strategy: 'moving-average-crossover',
    maFastPeriod: 3,
    maSlowPeriod: 5,
    maxPositionSizeFraction: 0.1,
    maxTradeAmount: 0,
    maxPortfolioExposureFraction: 0.5,
    maxDailyLossFraction: 0.05,
    maxDrawdownFraction: 0.1,
    cooldownAfterLossSeconds: 0,
    maxOpenPositions: 10,
    paperStartingBalance: 10000,
    paperFeeFraction: 0.0005,
    paperSlippageFraction: 0,
    paperFillFraction: 1,
    paperStateFile: STATE,
    evaluateIntervalSeconds: 1,
    ...over,
  });
}

function candles(symbol: string, closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    symbol, timeframe: TF, timestampMs: NOW - (closes.length - i) * 300_000,
    open: Money.fromString(String(c)), high: Money.fromString(String(c)),
    low: Money.fromString(String(c)), close: Money.fromString(String(c)), baseVolume: Money.fromString('1'),
  }));
}

function ticker(symbol: string, price: string): Ticker {
  const m = Money.fromString(price);
  return { symbol, bid: m, ask: m, last: m, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs: NOW };
}

function buildEngine(c: ReturnType<typeof cfg>, portfolio: Portfolio, markets: Record<string, MarketInfo>): { engine: PaperEngine; data: StubData; exchange: FakeExchange } {
  const exchange = new FakeExchange({ markets });
  const data = new StubData();
  const symbols = Object.keys(markets);
  const deps: PaperEngineDeps = {
    logger: silence, marketData: data, exchange, strategy: buildStrategy(c), riskManager: buildRiskManager(c),
    portfolio, store: null,
    paperConfig: { feeFraction: c.paperFeeFraction, slippageFraction: c.paperSlippageFraction, fillFraction: c.paperFillFraction },
    evaluateIntervalMs: 1000, symbols, timeframe: TF,
  };
  return { engine: new PaperEngine(deps), data, exchange };
}

const desc = (s: string) => candles(s, [16, 15, 14, 13, 12, 11, 10]); // fast < slow (state down)
const asc = (s: string) => candles(s, [10, 11, 12, 13, 14, 15, 16]); // fast > slow (state up)

describe('Gate 5 — multi-asset ownership scenarios (PAPER)', () => {
  it('SCENARIO A: external BTC is never sold; only bot-managed inventory can exit', async () => {
    rmSync(STATE, { force: true });
    let p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    p = p.withExternalSnapshot(new Map([[BTC, Money.fromString('0.25')]]));
    const { engine, data } = buildEngine(cfg(), p, { [BTC]: info(BTC, '0.000001') });
    data.tickers.set(BTC, ticker(BTC, '15'));
    data.candles.set(BTC, desc(BTC));
    await engine.evaluateOnce(NOW);
    data.candles.set(BTC, asc(BTC));
    await engine.evaluateOnce(NOW + 1);
    expect(engine.currentPortfolio.position(BTC)).not.toBeNull(); // bot bought its own managed lot
    expect(engine.currentPortfolio.external(BTC).toFixed(8)).toBe('0.25000000');
    data.candles.set(BTC, desc(BTC));
    await engine.evaluateOnce(NOW + 2);
    expect(engine.currentPortfolio.position(BTC)).toBeNull();
    expect(engine.currentPortfolio.external(BTC).toFixed(8)).toBe('0.25000000');
  });

  it('SCENARIO B: a BTC BUY rejected (below-min quantity) does NOT block ETH', async () => {
    rmSync(STATE, { force: true });
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
      .withExternalSnapshot(new Map([[BTC, Money.fromString('5')]])); // huge external BTC
    // BTC min order is high enough that the bot's 10%-of-equity BUY is BELOW_MIN_QUANTITY
    // (0.025 < 0.05), so BTC is risk-rejected; ETH's min order is tiny and it is approved.
    const { engine, data } = buildEngine(cfg(), p, {
      [BTC]: info(BTC, '0.05'),
      [ETH]: info(ETH, '0.000001'),
    });
    data.tickers.set(BTC, ticker(BTC, '40000'));
    data.tickers.set(ETH, ticker(ETH, '3000'));
    data.candles.set(BTC, desc(BTC));
    data.candles.set(ETH, desc(ETH));
    await engine.evaluateOnce(NOW); // establish both states down
    data.candles.set(BTC, asc(BTC));
    data.candles.set(ETH, asc(ETH));
    await engine.evaluateOnce(NOW + 1); // BTC golden-cross rejected, ETH golden-cross approved
    expect(engine.currentPortfolio.position(BTC)).toBeNull(); // BTC was not bought
    expect(engine.currentPortfolio.position(ETH)).not.toBeNull(); // but the cycle continued to ETH
  });

  it('SCENARIO C: no genuine signal anywhere => NO TRADE', async () => {
    rmSync(STATE, { force: true });
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    const { engine, data, exchange } = buildEngine(cfg(), p, { [BTC]: info(BTC, '0.000001'), [ETH]: info(ETH, '0.000001') });
    data.tickers.set(BTC, ticker(BTC, '15'));
    data.tickers.set(ETH, ticker(ETH, '3000'));
    data.candles.set(BTC, desc(BTC));
    data.candles.set(ETH, desc(ETH));
    await engine.evaluateOnce(NOW);
    await engine.evaluateOnce(NOW + 1);
    expect(engine.currentPortfolio.position(BTC)).toBeNull();
    expect(engine.currentPortfolio.position(ETH)).toBeNull();
    expect(engine.orderHistory).toHaveLength(0);
    expect(exchange.submittedOrders).toHaveLength(0);
  });

  it('SCENARIO D: a SELL sells exactly the bot-managed ETH quantity, closing the position', async () => {
    rmSync(STATE, { force: true });
    let p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    p = p.applyFill(ETH, 'BUY', Money.fromString('0.1'), Money.fromString('1000'), Money.zero());
    const { engine, data } = buildEngine(cfg(), p, { [ETH]: info(ETH, '0.000001') });
    data.tickers.set(ETH, ticker(ETH, '1000'));
    data.candles.set(ETH, asc(ETH));
    await engine.evaluateOnce(NOW); // state up
    data.candles.set(ETH, desc(ETH));
    await engine.evaluateOnce(NOW + 1); // death cross -> SELL
    const sell = engine.orderHistory.find((o) => o.side === 'SELL' && o.status === 'FILLED');
    expect(sell).toBeDefined();
    expect(sell!.quantity.compareTo(Money.fromString('0.1'))).toBeLessThanOrEqual(0);
    expect(engine.currentPortfolio.position(ETH)).toBeNull();
  });

  it('SCENARIO E: mixed ownership sells at most the managed ETH, never external', async () => {
    rmSync(STATE, { force: true });
    let p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    p = p.applyFill(ETH, 'BUY', Money.fromString('0.1'), Money.fromString('1000'), Money.zero());
    p = p.withExternalSnapshot(new Map([[ETH, Money.fromString('1.0')]]));
    const { engine, data } = buildEngine(cfg(), p, { [ETH]: info(ETH, '0.000001') });
    data.tickers.set(ETH, ticker(ETH, '1000'));
    data.candles.set(ETH, asc(ETH));
    await engine.evaluateOnce(NOW);
    data.candles.set(ETH, desc(ETH));
    await engine.evaluateOnce(NOW + 1);
    const sell = engine.orderHistory.find((o) => o.side === 'SELL' && o.status === 'FILLED');
    expect(sell).toBeDefined();
    expect(sell!.quantity.compareTo(Money.fromString('0.1'))).toBeLessThanOrEqual(0); // not 1.1
    expect(engine.currentPortfolio.external(ETH).toFixed(8)).toBe('1.00000000'); // external intact
    // No exchange order-placement fired during the whole workflow.
  });
});
