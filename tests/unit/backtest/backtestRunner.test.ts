import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest } from '../../../src/backtest/index.js';
import { buildStrategy } from '../../../src/strategy/index.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { BacktestConfig } from '../../../src/backtest/types.js';
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
  marketDataTransportMaxAgeMs: 60000,
  maxClockSkewMs: 120000,
  paperStartingBalance: 10000,
  paperFeeFraction: 0.0005,
  paperSlippageFraction: 0,
  paperFillFraction: 1,
  paperStateFile: '.paper-state.json',
  orderLedgerFile: '.order-ledger.json',
  manualIntentFile: '.manual-intents.json',
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
    open: Money.fromNumber(close),
    high: Money.fromNumber(close * 1.02),
    low: Money.fromNumber(close * 0.98),
    close: Money.fromNumber(close),
    baseVolume: Money.fromString('5'),
  };
}

function risingSeries(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, 100 + i));
}

function fallingSeries(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, 200 - i));
}

function btConfig(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: 'BTC/CAD',
    timeframe: '1d',
    initialCash: Money.fromNumber(10000),
    quoteCurrency: 'CAD',
    feeModel: { kind: 'rate', currency: 'quote', rate: 0.002 },
    slippageFraction: 0,
    marketConstraints: {
      priceTick: Money.fromString('0.01'),
      quantityTick: Money.fromString('0.00000001'),
      minOrderBase: null,
    },
    ...over,
  };
}

function run(candles: Candle[], over?: Partial<BacktestConfig>) {
  return runBacktest({
    candles,
    config: btConfig(over),
    createStrategy: () => buildStrategy(cfg()),
    createRiskManager: () => buildRiskManager(cfg()),
  });
}

describe('Backtest runner — historical simulation with required metrics', () => {
  it('reports the required metrics and a non-negative equity path', () => {
    const result = run(risingSeries(40));
    const m = result.metrics;
    expect(m.barCount).toBe(40);
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
    expect(result.simulationLabel).toContain('NOT A PREDICTION');
  });

  it('produces a clean run over a falling series without going short', () => {
    const result = run(fallingSeries(30));
    expect(result.metrics.barCount).toBe(30);
    expect(result.finalQuoteCash.isNegative()).toBe(false);
  });

  it('records rejections as an array when risk blocks', () => {
    const result = runBacktest({
      candles: risingSeries(25),
      config: btConfig(),
      createStrategy: () => buildStrategy(cfg({ maxDailyLossFraction: 1 })),
      createRiskManager: () => buildRiskManager(cfg({ maxDailyLossFraction: 1 })),
    });
    expect(result.rejections).toBeInstanceOf(Array);
  });
});
