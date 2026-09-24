/**
 * F3 — explicit backtest spread cost model.
 *
 * OHLC candles carry no bid/ask history, so the spread is an EXPLICIT,
 * configurable assumption applied half per side: BUY pays above the reference,
 * SELL receives below it. Slippage remains a separate cost.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest, computeFillPrice, validateConfig, BacktestValidationError } from '../../../src/backtest/index.js';
import type { BacktestConfig } from '../../../src/backtest/types.js';
import { btConfig, flatSeries, stubStrategy, StubRisk, approveBuy, approveSell } from './helpers.js';

const TICK = Money.fromString('0.01');

describe('F3 — computeFillPrice spread by side', () => {
  it('BUY pays half the spread above the reference', () => {
    const p = computeFillPrice(Money.fromString('100'), 'BUY', 0, TICK, 0.02);
    expect(p.toString()).toBe('101.00000000');
  });

  it('SELL receives half the spread below the reference', () => {
    const p = computeFillPrice(Money.fromString('100'), 'SELL', 0, TICK, 0.02);
    expect(p.toString()).toBe('99.00000000');
  });

  it('zero spread is explicit and preserves the old (slippage-only) behavior', () => {
    expect(computeFillPrice(Money.fromString('100.123'), 'BUY', 0, TICK, 0).toString()).toBe('100.13000000');
    expect(computeFillPrice(Money.fromString('100.123'), 'SELL', 0, TICK, 0).toString()).toBe('100.12000000');
  });

  it('spread and slippage are additive and by side', () => {
    expect(computeFillPrice(Money.fromString('100'), 'BUY', 0.01, TICK, 0.02).toString()).toBe('102.00000000');
    expect(computeFillPrice(Money.fromString('100'), 'SELL', 0.01, TICK, 0.02).toString()).toBe('98.00000000');
  });
});

describe('F3 — validation', () => {
  it('rejects a missing spread assumption', () => {
    const cfg = { ...btConfig() } as Record<string, unknown>;
    delete cfg.spreadFraction;
    expect(() => validateConfig(cfg as unknown as BacktestConfig)).toThrow(/spreadFraction/);
  });

  it('rejects a negative or > 1 spread', () => {
    expect(() => validateConfig(btConfig({ spreadFraction: -0.01 }))).toThrow(BacktestValidationError);
    expect(() => validateConfig(btConfig({ spreadFraction: 1.5 }))).toThrow(/spreadFraction/);
  });
});

describe('F3 — engine applies spread and preserves cash conservation', () => {
  it('a zero-spread run records the explicit assumption and warns', () => {
    const result = runBacktest({
      candles: flatSeries(3, 100),
      config: btConfig(),
      createStrategy: () => stubStrategy(['HOLD', 'HOLD', 'HOLD']),
      createRiskManager: () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100'))),
    });
    expect(result.spreadFraction).toBe(0);
    expect(result.warnings.some((w) => /spreadFraction is 0/.test(w))).toBe(true);
  });

  it('a round trip with spread costs the full spread and never overdraws', () => {
    const result = runBacktest({
      candles: flatSeries(4, 100),
      config: btConfig({ initialCash: Money.fromString('1000'), spreadFraction: 0.02 }),
      createStrategy: () => stubStrategy(['BUY', 'SELL', 'HOLD', 'HOLD']),
      createRiskManager: () =>
        new StubRisk((ctx) =>
          ctx.signal.type === 'BUY'
            ? approveBuy(Money.fromString('5'), Money.fromString('100'))
            : approveSell(Money.fromString('5'), Money.fromString('100')),
        ),
    });
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0]!.price.toString()).toBe('101.00000000'); // BUY pays up
    expect(result.trades[1]!.price.toString()).toBe('99.00000000'); // SELL receives down
    // 1000 - 5*101 + 5*99 = 990 (a 10-quote round-trip spread cost).
    expect(result.finalQuoteCash.toString()).toBe('990.00000000');
    expect(result.finalQuoteCash.isNegative()).toBe(false);
    expect(result.spreadFraction).toBe(0.02);
  });

  it('cash conservation still holds with spread + fee + slippage', () => {
    const result = runBacktest({
      candles: flatSeries(4, 100),
      config: btConfig({
        initialCash: Money.fromString('1000'),
        spreadFraction: 0.01,
        slippageFraction: 0.005,
        feeModel: { kind: 'rate', currency: 'quote', rate: 0.001 },
      }),
      createStrategy: () => stubStrategy(['BUY', 'SELL', 'HOLD', 'HOLD']),
      createRiskManager: () =>
        new StubRisk((ctx) =>
          ctx.signal.type === 'BUY'
            ? approveBuy(Money.fromString('5'), Money.fromString('100'))
            : approveSell(Money.fromString('5'), Money.fromString('100')),
        ),
    });
    let cash = result.config.initialCash;
    for (const t of result.trades) {
      cash = t.side === 'BUY' ? cash.sub(t.notional.add(t.fee)) : cash.add(t.notional.sub(t.fee));
    }
    expect(cash.toString()).toBe(result.finalQuoteCash.toString());
    expect(result.finalQuoteCash.isNegative()).toBe(false);
  });
});
