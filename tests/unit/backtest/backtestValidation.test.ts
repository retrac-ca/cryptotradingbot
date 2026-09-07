/**
 * Backtesting V1 — fail-closed validation tests.
 *
 * Malformed / ambiguous historical input must be rejected deterministically,
 * never silently repaired. Covers candles and market constraints.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest, BacktestValidationError, validateCandles, validateConfig } from '../../../src/backtest/index.js';
import type { BacktestConfig } from '../../../src/backtest/types.js';
import type { Candle } from '../../../src/types.js';
import { btConfig, candle, flatSeries, stubStrategy, StubRisk } from './helpers.js';

function run(candles: Candle[], config: BacktestConfig = btConfig(), strategy = stubStrategy(['HOLD'])) {
  return runBacktest({
    candles,
    config,
    createStrategy: () => strategy,
    createRiskManager: () => new StubRisk(() => ({ approved: false, symbol: 'BTC/CAD', side: null, reason: 'NO_ACTION', appliedLimits: { maxTradeAmount: Money.zero(), maxPositionSizeFraction: 1, maxPortfolioExposureFraction: 1, maxDailyLossFraction: 1, maxDrawdownFraction: 1, cooldownAfterLossMs: 0, maxOpenPositions: 0, killSwitchActive: false } })),
  });
}

describe('Backtesting V1 — candle validation', () => {
  it('rejects an empty dataset', () => {
    expect(() => run([])).toThrow(BacktestValidationError);
    expect(validateCandles([]).ok).toBe(false);
  });

  it('rejects duplicate timestamps', () => {
    const dup = [candle(0, 100), candle(1, 100)];
    dup[1] = { ...dup[1]!, timestampMs: dup[0]!.timestampMs };
    expect(() => run(dup)).toThrow(/strictly ascending|duplicate|timestamp/i);
  });

  it('rejects non-ascending (unsorted) timestamps', () => {
    const unsorted = [candle(2, 100), candle(0, 100), candle(1, 100)];
    expect(() => run(unsorted)).toThrow(/strictly ascending|timestamp/i);
  });

  it('rejects an invalid (non-finite/<=0) timestamp', () => {
    const bad = flatSeries(3, 100);
    bad[1] = { ...bad[1]!, timestampMs: Number.NaN };
    expect(() => run(bad)).toThrow(/timestamp/i);
  });

  it('rejects non-positive prices', () => {
    const bad = flatSeries(3, 100);
    bad[1] = { ...bad[1]!, close: Money.zero() };
    expect(() => run(bad)).toThrow(/close.*positive|positive/i);
  });

  it('rejects impossible OHLC (high < low)', () => {
    const bad = flatSeries(3, 100);
    bad[1] = { ...bad[1]!, high: Money.fromString('90') };
    expect(() => run(bad)).toThrow(/high.*below low/i);
  });

  it('rejects impossible OHLC (close outside [low, high])', () => {
    const bad = flatSeries(3, 100);
    bad[1] = { ...bad[1]!, close: Money.fromString('200'), high: Money.fromString('150') };
    expect(() => run(bad)).toThrow(/high.*below open\/close|high.*close/i);
  });

  it('rejects negative base volume', () => {
    const bad = flatSeries(3, 100);
    bad[1] = { ...bad[1]!, baseVolume: Money.fromString('-1') };
    expect(() => run(bad)).toThrow(/baseVolume/i);
  });
});

describe('Backtesting V1 — market constraint validation', () => {
  it('rejects missing priceTick', () => {
    const cfg = {
      ...btConfig(),
      marketConstraints: { quantityTick: Money.fromString('0.00000001'), minOrderBase: null },
    } as unknown as BacktestConfig;
    expect(() => validateConfig(cfg)).toThrow(/priceTick/);
  });

  it('rejects non-positive priceTick', () => {
    expect(() => validateConfig(btConfig({ marketConstraints: { priceTick: Money.zero(), quantityTick: Money.fromString('0.00000001'), minOrderBase: null } }))).toThrow(/priceTick/);
  });

  it('rejects non-positive quantityTick', () => {
    expect(() => validateConfig(btConfig({ marketConstraints: { priceTick: Money.fromString('0.01'), quantityTick: Money.zero(), minOrderBase: null } }))).toThrow(/quantityTick/);
  });

  it('rejects a negative minOrderBase', () => {
    expect(() => validateConfig(btConfig({ marketConstraints: { priceTick: Money.fromString('0.01'), quantityTick: Money.fromString('0.00000001'), minOrderBase: Money.fromString('-1') } }))).toThrow(/minOrderBase/);
  });

  it('accepts null minOrderBase (no minimum enforced)', () => {
    expect(() => validateConfig(btConfig())).not.toThrow();
    const cfg = btConfig();
    expect(cfg.marketConstraints.minOrderBase).toBeNull();
  });

  it('rejects negative fee rate', () => {
    expect(() => validateConfig(btConfig({ feeModel: { kind: 'rate', currency: 'quote', rate: -0.1 } }))).toThrow(/fee rate/);
  });

  it('rejects a non-finite fee rate', () => {
    expect(() => validateConfig(btConfig({ feeModel: { kind: 'rate', currency: 'quote', rate: Number.NaN } }))).toThrow(/fee rate/);
  });

  it('rejects negative slippage', () => {
    expect(() => validateConfig(btConfig({ slippageFraction: -0.01 }))).toThrow(/slippage/);
  });

  it('rejects a non-finite slippage', () => {
    expect(() => validateConfig(btConfig({ slippageFraction: Number.POSITIVE_INFINITY }))).toThrow(/slippage/);
  });

  it('rejects base-denominated fee currency (never silently converted)', () => {
    const cfg = btConfig({
      feeModel: { kind: 'rate', currency: 'base', rate: 0.002 } as unknown as BacktestConfig['feeModel'],
    });
    expect(() => validateConfig(cfg)).toThrow(/fee currency|quote/i);
  });
});

describe('Backtesting V1 — warmup / dataset sufficiency', () => {
  it('rejects a dataset too short to warm up the strategy', () => {
    // warmup 5, but only 3 candles -> cannot produce an executable signal.
    expect(() => run(flatSeries(3, 100), btConfig(), stubStrategy(['HOLD', 'HOLD', 'HOLD'], 5))).toThrow(/insufficient candle data|warm/i);
  });
});
