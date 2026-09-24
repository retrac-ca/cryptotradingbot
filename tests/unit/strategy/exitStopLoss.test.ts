/**
 * F1 — robust (level-based) exit + enforced stop-loss.
 *
 * The exit no longer depends on a fresh transition, so a long position cannot
 * be stranded by a cross that happened while the process was offline. The
 * stop-loss derives from the DURABLE position entry basis and emits a normal
 * SELL signal that still flows through RiskManager.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { MovingAverageCrossoverStrategy } from '../../../src/strategy/movingAverageCrossover.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../../src/types.js';
import type { StrategyContext, PositionView } from '../../../src/strategy/StrategyContext.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '5m';
const NOW = 10_000_000;

function candle(close: string, i: number): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: NOW - (10 - i) * 300_000,
    open: Money.fromString(close),
    high: Money.fromString(close),
    low: Money.fromString(close),
    close: Money.fromString(close),
    baseVolume: Money.fromString('1'),
  };
}

function series(closes: string[]): Candle[] {
  return closes.map((c, i) => candle(c, i));
}

function ticker(last: string): Ticker {
  return {
    symbol: SYMBOL,
    bid: Money.fromString(last),
    ask: Money.fromString(last),
    last: Money.fromString(last),
    open: null,
    high: null,
    low: null,
    baseVolume: null,
    quoteVolume: null,
    timestampMs: NOW,
    observedAtMs: NOW,
  };
}

function context(
  closes: string[],
  opts: { quantity?: string; entry?: string; price?: string; ticker?: Ticker | null } = {},
): StrategyContext {
  const position: PositionView = {
    symbol: SYMBOL,
    quantity: opts.quantity ? Money.fromString(opts.quantity) : Money.zero(),
    averageEntryPrice: opts.entry ? Money.fromString(opts.entry) : null,
    entryAnchorPrice: null,
    realizedPnl: Money.zero(),
  };
  const candles = series(closes);
  return {
    nowMs: NOW,
    symbol: SYMBOL,
    ticker: opts.ticker === undefined ? ticker(closes[closes.length - 1]!) : opts.ticker,
    candles,
    timeframe: TF,
    position,
    insufficientData: candles.length < 4,
  };
}

const BEARISH = ['16', '15', '14', '13', '12', '11', '10'];
const BULLISH = ['10', '11', '12', '13', '14', '15', '16'];

describe('F1 — level-based exit', () => {
  it('a long with fast below slow is SELL even on a fresh instance (no transition needed)', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0 });
    const sig = s.evaluate(context(BEARISH, { quantity: '0.5', entry: '100' }));
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/below slow/);
  });

  it('is restart-equivalent: a brand-new instance still exits the restored long', () => {
    // No prior evaluation establishes crossState, simulating a process restart.
    const fresh = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0 });
    const sig = fresh.evaluate(context(BEARISH, { quantity: '0.5', entry: '100' }));
    expect(sig.type).toBe('SELL');
  });

  it('equality (fast === slow) is HOLD, not SELL', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0 });
    const flatPrices = ['10', '10', '10', '10', '10', '10', '10'];
    const sig = s.evaluate(context(flatPrices, { quantity: '0.5', entry: '100' }));
    expect(sig.type).toBe('HOLD');
  });
});

describe('F1 — stop-loss', () => {
  it('a long below the stop threshold is SELL even while the MA is bullish', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0.1 });
    // Bullish MA (fast above slow), but price 80 is below 100 * 0.9 = 90.
    const sig = s.evaluate(context(BULLISH, { quantity: '0.5', entry: '100', ticker: ticker('80') }));
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/stop-loss/);
  });

  it('a long above the stop threshold holds while the MA is bullish', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0.1 });
    const sig = s.evaluate(context(BULLISH, { quantity: '0.5', entry: '100', ticker: ticker('95') }));
    expect(sig.type).toBe('HOLD');
  });

  it('a flat position can never generate a stop-loss SELL', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0.1 });
    // Price far below a hypothetical entry, but we are flat.
    const sig = s.evaluate(context(BULLISH, { quantity: '0', entry: '100', ticker: ticker('1') }));
    expect(sig.type).not.toBe('SELL');
    expect(sig.type).toBe('HOLD');
  });

  it('a long with a zero/absent entry basis has no stop (external inventory)', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0.1 });
    const sig = s.evaluate(context(BULLISH, { quantity: '0.5', ticker: ticker('1') }));
    expect(sig.type).toBe('HOLD');
  });
});

describe('F1 — BUY crossover behavior preserved', () => {
  it('flat + fresh golden cross still BUYs', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0 });
    // Establish fast-below, then cross above.
    s.evaluate(context(BEARISH));
    const sig = s.evaluate(context(BULLISH));
    expect(sig.type).toBe('BUY');
  });

  it('flat + no cross stays HOLD', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0 });
    const sig = s.evaluate(context(BEARISH));
    expect(sig.type).toBe('HOLD');
  });
});

describe('F1 — exit flows through the existing risk path', () => {
  const riskCfg: RiskConfig = {
    maxTradeAmount: Money.zero(),
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

  const marketInfo: MarketInfo = {
    symbol: SYMBOL,
    exchangeId: 'x',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 8,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: null,
    minOrderQuote: null,
    supportsMarketOrders: true,
    feeInfo: { maker: 0.001, taker: 0.001, feeCurrency: 'quote' },
  };

  it('a stop-loss SELL from the strategy is approved and selected by the coordinator', () => {
    let portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    portfolio = portfolio.applyFill(SYMBOL, 'BUY', Money.fromString('0.5'), Money.fromString('100'), Money.zero());

    const strategy = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3, stopLossFraction: 0.1 });
    const coordinator = new MarketCoordinator({
      strategy,
      riskManager: new RiskManager(riskCfg),
      getPortfolio: () => portfolio,
      timeframe: TF,
      marketSource: {
        getMarketInfo: () => marketInfo,
        getTicker: () => ticker('80'), // below the 90 stop threshold
        getCandles: () => series(BULLISH),
      },
      freshnessPolicy: { maxQuoteAgeMs: 60_000, maxTransportAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 },
    });

    const result = coordinator.evaluate([SYMBOL], NOW);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.side).toBe('SELL');
    expect(result.evaluated[0]!.signalType).toBe('SELL');
  });
});
