import { describe, expect, it } from 'vitest';
import { buildStrategy } from '../../../src/strategy/buildStrategy.js';
import type { BotConfig } from '../../../src/config/schema.js';

const baseConfig = (over: Partial<BotConfig> = {}): BotConfig =>
  ({
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
    timeframe: '5m',
    maFastPeriod: 2,
    maSlowPeriod: 30,
    maxPositionSizeFraction: 0.1,
    maxTradeAmount: 0,
    stopLossFraction: 0.05,
    takeProfitFraction: 0.1,
    maxDailyLossFraction: 0.05,
    maxOpenPositions: 1,
    cooldownAfterLossSeconds: 3600,
    paperStartingBalance: 10000,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    ...over,
  }) as BotConfig;

describe('buildStrategy', () => {
  it('builds the configured strategy from bot config', () => {
    const s = buildStrategy(baseConfig());
    expect(s.id).toBe('moving-average-crossover');
    expect(s.timeframe).toBe('5m');
    expect(s.describe()).toContain('fast=2');
    expect(s.describe()).toContain('slow=30');
  });

  it('honors a timeframe override', () => {
    const s = buildStrategy(baseConfig(), '1h');
    expect(s.timeframe).toBe('1h');
  });

  it('propagates fast/slow periods from config', () => {
    const s = buildStrategy(baseConfig({ maFastPeriod: 5, maSlowPeriod: 20 }));
    expect(s.describe()).toContain('fast=5');
    expect(s.describe()).toContain('slow=20');
  });

  it('throws for an unknown strategy name', () => {
    expect(() => buildStrategy(baseConfig({ strategy: 'nope' }))).toThrow(/nope/);
  });
});
