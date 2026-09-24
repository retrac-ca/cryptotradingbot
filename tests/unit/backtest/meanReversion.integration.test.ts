/**
 * Mean reversion — deterministic backtest integration.
 *
 * Verifies the strategy drives the EXISTING backtest engine end-to-end:
 * an extended entry BUY, a reversion SELL, no shorting, exact accounting, and
 * run-to-run determinism. The engine is NOT modified to support this.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest } from '../../../src/backtest/index.js';
import { MeanReversionStrategy } from '../../../src/strategy/index.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { btConfig, candle, approveBuy, approveSell, StubRisk, TF } from './helpers.js';

const PERIOD = 48;

/** 100 x 48, then a 2% dip (entry) and a recovery to 100 (exit). */
const CLOSES = [
  ...Array(48).fill('100'),
  '98', // i=48: ~1.96% below MA48 -> BUY
  '99',
  '100', // i=50: back at/above MA48 -> SELL
  '100',
];

function run() {
  const candles = CLOSES.map((c, i) => candle(i, Number(c)));
  return runBacktest({
    candles,
    config: btConfig(),
    createStrategy: () =>
      new MeanReversionStrategy(TF, { period: PERIOD, deviationThreshold: 0.015 }),
    createRiskManager: () =>
      new StubRisk((ctx: RiskContext) => {
        const qty = Money.fromString('1');
        const price = ctx.price ?? Money.fromString('1');
        return ctx.signal.type === 'BUY' ? approveBuy(qty, price) : approveSell(qty, price);
      }),
  });
}

describe('Mean reversion — backtest integration', () => {
  it('produces an extended-entry BUY and a reversion SELL', () => {
    const result = run();
    expect(result.trades.map((t) => t.side)).toEqual(['BUY', 'SELL']);
    // BUY signal at close[48]=98 fills at next open 99; SELL at close[50]=100 fills at next open 100.
    expect(result.trades[0]!.price.toString()).toBe('99.00000000');
    expect(result.trades[1]!.price.toString()).toBe('100.00000000');
  });

  it('never shorts, never sells before buying, and produces no impossible fills', () => {
    const result = run();
    expect(result.trades[0]!.side).toBe('BUY');
    expect(result.finalPositionQty.isZero()).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  it('keeps portfolio accounting exact', () => {
    const result = run();
    // 10000 - 99 (BUY) + 100 (SELL) = 10001, flat at the end.
    expect(result.finalQuoteCash.toString()).toBe('10001.00000000');
    expect(result.trades[1]!.realizedPnl!.toString()).toBe('1.00000000');
  });

  it('is deterministic across identical runs', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
