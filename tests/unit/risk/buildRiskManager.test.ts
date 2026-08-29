import { describe, expect, it } from 'vitest';
import { buildRiskConfig, buildRiskManager } from '../../../src/risk/buildRiskManager.js';
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
    maxPortfolioExposureFraction: 0.5,
    maxDrawdownFraction: 0.1,
    marketDataMaxAgeMs: 60000,
    paperStartingBalance: 10000,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    ...over,
  }) as BotConfig;

describe('buildRiskConfig / buildRiskManager', () => {
  it('maps configured risk values into the RiskConfig', () => {
    const cfg = buildRiskConfig(baseConfig());
    expect(cfg.maxPositionSizeFraction).toBe(0.1);
    expect(cfg.maxPortfolioExposureFraction).toBe(0.5);
    expect(cfg.maxDailyLossFraction).toBe(0.05);
    expect(cfg.maxDrawdownFraction).toBe(0.1);
    expect(cfg.cooldownAfterLossMs).toBe(3600_000);
    expect(cfg.marketDataMaxAgeMs).toBe(60000);
    expect(cfg.maxTradeAmount.toFixed(2)).toBe('0.00');
  });

  it('converts the kill switch config into an active kill switch', () => {
    const off = buildRiskManager(baseConfig());
    expect(off.getKillSwitchActive()).toBe(false);

    const on = buildRiskManager(baseConfig({ killSwitch: true }));
    expect(on.getKillSwitchActive()).toBe(true);
  });

  it('honors a non-zero max trade amount', () => {
    const cfg = buildRiskConfig(baseConfig({ maxTradeAmount: 2500 }));
    expect(cfg.maxTradeAmount.toFixed(2)).toBe('2500.00');
  });
});
