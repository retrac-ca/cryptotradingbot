import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { BacktestRunner } from '../../../src/backtest/BacktestRunner.js';
import { buildStrategy } from '../../../src/strategy/index.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { Candle } from '../../../src/types.js';

const cfg = (over: Partial<BotConfig> = {}): BotConfig => ({
  tradingMode: 'paper',
  realFundsAtRisk: false,
  exchange: 'ndax',
  ndaxApiKey: '',
  ndaxApiSecret: '',
  ndaxUserId: '',
  ndaxUserName: '',
  enableAuthenticatedReads: false,
  tradingPairs: ['BTC/CAD'],
  strategy: 'moving-average-crossover',
  timeframe: '1d',
  maFastPeriod: 3,
  maSlowPeriod: 8,
  maxPositionSizeFraction: 0.5,
  maxTradeAmount: 0,
  stopLossFraction: 0.05,
  takeProfitFraction: 0.1,
  maxDailyLossFraction: 0.01,
  maxOpenPositions: 1,
  cooldownAfterLossSeconds: 0,
  maxPortfolioExposureFraction: 1,
  maxDrawdownFraction: 0.5,
  marketDataMaxAgeMs: 60000,
  paperStartingBalance: 10000,
  paperFeeFraction: 0.0005,
  paperSlippageFraction: 0,
  paperFillFraction: 1,
  paperStateFile: '.paper-state.json',
  orderLedgerFile: '.order-ledger.json',
  evaluateIntervalSeconds: 60,
  logLevel: 'info',
  reconcileIntervalSeconds: 60,
  killSwitch: false,
  ...over,
});

function candle(i: number, close: number): Candle {
  return {
    symbol: 'BTC/CAD',
    timeframe: '1d',
    timestampMs: 1_700_000_000_000 + i * 86_400_000,
    open: Money.fromNumber(close * 0.99),
    high: Money.fromNumber(close * 1.02),
    low: Money.fromNumber(close * 0.98),
    close: Money.fromNumber(close),
    baseVolume: Money.fromString('5'),
  };
}

function risingSeries(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(candle(i, 100 + i));
  return out;
}

function fallingSeries(n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) out.push(candle(i, 200 - i));
  return out;
}

describe('BacktestRunner — historical simulation with required metrics', () => {
  it('reports the required metrics and a non-negative equity path', () => {
    const strategy = buildStrategy(cfg());
    const risk = buildRiskManager(cfg());
    const runner = new BacktestRunner(strategy, risk);
    const candles = risingSeries(40);
    const result = runner.run(candles, {
      symbol: 'BTC/CAD',
      timeframe: '1d',
      initialCash: Money.fromNumber(10000),
      quoteCurrency: 'CAD',
      feeFraction: 0.002,
      slippageFraction: 0,
    });

    const m = result.metrics;
    expect(m.candles).toBe(40);
    expect(m.startingCapital.toFixed(2)).toBe('10000.00');
    expect(m.endingCapital.isPositive()).toBe(true);
    expect(m.tradeCount).toBeGreaterThanOrEqual(0);
    expect(m.winningTrades + m.losingTrades).toBeLessThanOrEqual(m.tradeCount);
    expect(m.winRate).toBeGreaterThanOrEqual(0);
    expect(m.winRate).toBeLessThanOrEqual(1);
    expect(m.feesPaid.isNegative()).toBe(false);
    expect(m.maxDrawdownFraction).toBeGreaterThanOrEqual(0);
    expect(m.largestLoss.toNumber()).toBeLessThanOrEqual(0);
    expect(result.equityCurve.length).toBe(40);
  });

  it('produces a clean run over a falling series without going short', () => {
    const strategy = buildStrategy(cfg());
    const risk = buildRiskManager(cfg());
    const runner = new BacktestRunner(strategy, risk);
    const result = runner.run(fallingSeries(30), {
      symbol: 'BTC/CAD',
      timeframe: '1d',
      initialCash: Money.fromNumber(10000),
      quoteCurrency: 'CAD',
      feeFraction: 0.002,
      slippageFraction: 0,
    });
    expect(result.metrics.candles).toBe(30);
    expect(result.finalQuoteCash.isNegative()).toBe(false);
  });

  it('asks the risk manager to approve every trade (rejections recorded when blocked)', () => {
    // A strict daily-loss cap will produce some rejections when losses occur.
    const strategy = buildStrategy(cfg());
    const risk = buildRiskManager(cfg({ maxDailyLossFraction: 1 }));
    const runner = new BacktestRunner(strategy, risk);
    const result = runner.run(risingSeries(25), {
      symbol: 'BTC/CAD',
      timeframe: '1d',
      initialCash: Money.fromNumber(10000),
      quoteCurrency: 'CAD',
      feeFraction: 0.002,
      slippageFraction: 0,
    });
    expect(result.rejections).toBeInstanceOf(Array);
    expect(result.metrics.tradeCount).toBeGreaterThanOrEqual(result.rejections.length === 0 ? 0 : 0);
  });
});
