import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigLoadError } from '../../src/config/load.js';
import type { BotConfig } from '../../src/config/schema.js';

/** Minimal valid env source. */
function baseEnv(): Record<string, string> {
  return {
    TRADING_MODE: 'paper',
    EXCHANGE: 'ndax',
    TRADING_PAIRS: 'BTC/CAD',
    STRATEGY: 'moving-average-crossover',
    TIMEFRAME: '5m',
    MA_FAST_PERIOD: '10',
    MA_SLOW_PERIOD: '30',
    MAX_POSITION_SIZE_FRACTION: '0.1',
    PAPER_STARTING_BALANCE: '10000',
  };
}

describe('loadConfig', () => {
  it('loads a valid paper config with defaults', () => {
    const cfg = loadConfig(baseEnv() as NodeJS.ProcessEnv);
    expect(cfg.tradingMode).toBe('paper');
    expect(cfg.exchange).toBe('ndax');
    expect(cfg.tradingPairs).toEqual(['BTC/CAD']);
    expect(cfg.universeMarkets).toEqual(['BTC/CAD', 'ETH/CAD', 'SOL/CAD', 'XRP/CAD', 'ADA/CAD']);
    expect(cfg.strategy).toBe('moving-average-crossover');
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.maxOpenPositions).toBe(1);
  });

  it('parses comma-separated trading pairs', () => {
    const env = { ...baseEnv(), TRADING_PAIRS: 'BTC/CAD, ETH/CAD' };
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.tradingPairs).toEqual(['BTC/CAD', 'ETH/CAD']);
  });

  it('rejects invalid trading pair format', () => {
    const env = { ...baseEnv(), TRADING_PAIRS: 'not-a-pair' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(ConfigLoadError);
  });

  it('defaults tradingMode to paper when unset', () => {
    const env = baseEnv();
    delete env.TRADING_MODE;
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.tradingMode).toBe('paper');
  });

  it('rejects live trading without REAL_FUNDS_AT_RISK', () => {
    const env = { ...baseEnv(), TRADING_MODE: 'live' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/REAL_FUNDS_AT_RISK/);
  });

  it('allows live trading with REAL_FUNDS_AT_RISK set', () => {
    const env = { ...baseEnv(), TRADING_MODE: 'live', REAL_FUNDS_AT_RISK: 'true' };
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.tradingMode).toBe('live');
    expect(cfg.realFundsAtRisk).toBe(true);
  });

  it('rejects slow period <= fast period', () => {
    const env = { ...baseEnv(), MA_FAST_PERIOD: '30', MA_SLOW_PERIOD: '10' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/MA_SLOW_PERIOD/);
  });

  it('rejects zero max position size', () => {
    const env = { ...baseEnv(), MAX_POSITION_SIZE_FRACTION: '0' };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/MAX_POSITION_SIZE_FRACTION/);
  });

  it('parses fraction config prudently', () => {
    const env = { ...baseEnv(), MAX_POSITION_SIZE_FRACTION: '0.25' };
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.maxPositionSizeFraction).toBe(0.25);
  });

  it('loads Phase 7 risk fields with conservative defaults', () => {
    const cfg = loadConfig(baseEnv() as NodeJS.ProcessEnv);
    expect(cfg.maxPortfolioExposureFraction).toBe(0.5);
    expect(cfg.maxDrawdownFraction).toBe(0.1);
    expect(cfg.marketDataMaxAgeMs).toBe(60000);
    expect(cfg.marketDataTransportMaxAgeMs).toBe(60000);
    expect(cfg.maxClockSkewMs).toBe(120000);
    expect(cfg.killSwitch).toBe(false);
  });

  it('parses Phase 7 risk overrides', () => {
    const env = {
      ...baseEnv(),
      MAX_PORTFOLIO_EXPOSURE_FRACTION: '0.8',
      MAX_DRAWDOWN_FRACTION: '0.2',
      MARKET_DATA_MAX_AGE_MS: '30000',
      MARKET_DATA_TRANSPORT_MAX_AGE_MS: '45000',
      MAX_CLOCK_SKEW_MS: '90000',
      KILL_SWITCH: 'true',
    };
    const cfg = loadConfig(env as NodeJS.ProcessEnv);
    expect(cfg.maxPortfolioExposureFraction).toBe(0.8);
    expect(cfg.maxDrawdownFraction).toBe(0.2);
    expect(cfg.marketDataMaxAgeMs).toBe(30000);
    expect(cfg.marketDataTransportMaxAgeMs).toBe(45000);
    expect(cfg.maxClockSkewMs).toBe(90000);
    expect(cfg.killSwitch).toBe(true);
  });

  it('collects multiple field errors in details', () => {
    const env: Record<string, string> = { TRADING_PAIRS: 'bad', EXPLODE_UNKNOWN_KEY: 'x' };
    const actual = baseEnv();
    const merged = { ...actual, ...env, TRADING_MODE: 'nonsense' };
    try {
      loadConfig(merged as NodeJS.ProcessEnv);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      const e = err as ConfigLoadError;
      expect(Object.keys(e.details).length).toBeGreaterThan(0);
    }
  });

  it('returns a fully-typed config', () => {
    const cfg: BotConfig = loadConfig(baseEnv() as NodeJS.ProcessEnv);
    expect(typeof cfg.maFastPeriod).toBe('number');
    expect(Array.isArray(cfg.tradingPairs)).toBe(true);
    expect(typeof cfg.stopLossFraction).toBe('number');
  });
});
