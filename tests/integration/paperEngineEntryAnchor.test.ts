/**
 * Proves the entry anchor travels the FULL paper path:
 * strategy signal -> coordinator SelectedTrade -> PaperOrderRequest ->
 * Portfolio.applyFill -> Position.entryAnchorPrice.
 */

import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../src/money/Money.js';
import { Portfolio } from '../../src/portfolio/Portfolio.js';
import { FakeExchange } from '../fakes/FakeExchange.js';
import { PaperEngine } from '../../src/engine/PaperEngine.js';
import type { PaperEngineDeps } from '../../src/engine/PaperEngine.js';
import { buildRiskManager } from '../../src/risk/index.js';
import { botConfigSchema } from '../../src/config/schema.js';
import { signal } from '../../src/strategy/Signal.js';
import type { Strategy } from '../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../src/strategy/StrategyContext.js';
import type { MarketDataProvider } from '../../src/marketdata/types.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../src/types.js';
import type { Logger } from '../../src/logging/logger.js';
import type { FreshnessPolicy } from '../../src/marketdata/freshness.js';
import { statePath } from '../helpers/state.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '5m';
const STATE_FILE = statePath('paper-anchor', 'state.json');
const ANCHOR = Money.fromString('123.45');

const silence: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silence,
};

/** Emits a BUY (with an anchor) whenever flat, HOLD otherwise. */
class AnchorEntryStrategy implements Strategy {
  readonly id = 'anchor-entry';
  readonly name = 'anchor-entry';
  readonly timeframe: Timeframe = TF;
  readonly warmupCandles = 1;
  evaluate(ctx: StrategyContext): ReturnType<typeof signal> {
    if (ctx.position.quantity.isZero()) {
      return signal(ctx.symbol, 'BUY', { reason: 'anchor-entry', entryAnchorPrice: ANCHOR }, ctx.nowMs);
    }
    return signal(ctx.symbol, 'HOLD', {}, ctx.nowMs);
  }
  describe(): string {
    return 'anchor-entry';
  }
}

class StubMarketData implements MarketDataProvider {
  readonly symbols = [SYMBOL];
  ticker: Ticker | null = null;
  candles: Candle[] = [];
  getTicker(): Ticker | null {
    if (!this.ticker) return null;
    return { ...this.ticker, observedAtMs: this.ticker.observedAtMs ?? this.ticker.timestampMs };
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
    paperFeeFraction: 0,
    paperSlippageFraction: 0,
    paperFillFraction: 1,
    paperStateFile: STATE_FILE,
    evaluateIntervalSeconds: 1,
  });
}

const freshnessPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: 60_000,
  maxTransportAgeMs: 60_000,
  maxAcceptableFutureSkewMs: 120_000,
};

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

describe('PaperEngine entry anchor — end-to-end', () => {
  it('carries the signal anchor into the filled paper position', async () => {
    rmSync(STATE_FILE, { force: true });
    const c = cfg();
    const data = new StubMarketData();
    const exchange = new FakeExchange({ markets: { [SYMBOL]: marketInfo() } });
    const cash = new Map([['CAD', Money.fromString('10000')]]);
    const deps: PaperEngineDeps = {
      logger: silence,
      marketData: data,
      exchange,
      strategy: new AnchorEntryStrategy(),
      riskManager: buildRiskManager(c),
      portfolio: Portfolio.empty(cash),
      store: null,
      paperConfig: { feeFraction: 0, slippageFraction: 0, fillFraction: 1 },
      evaluateIntervalMs: 1000,
      symbols: [SYMBOL],
      timeframe: TF,
      freshnessPolicy,
    };
    const engine = new PaperEngine(deps);

    const now = 1_000_000;
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
      observedAtMs: now,
    };
    data.candles = candles([15, 15, 15], now);

    await engine.evaluateOnce(now);

    const pos = engine.currentPortfolio.position(SYMBOL);
    expect(pos).not.toBeNull();
    expect(pos!.entryAnchorPrice).not.toBeNull();
    expect(pos!.entryAnchorPrice!.equals(ANCHOR)).toBe(true);
    expect(engine.orderHistory.some((o) => o.side === 'BUY' && o.status === 'FILLED')).toBe(true);

    rmSync(STATE_FILE, { force: true });
  });
});
