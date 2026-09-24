/**
 * Donchian breakout — deterministic backtest integration.
 *
 * Verifies the strategy drives the EXISTING backtest engine end-to-end:
 * a breakout BUY, a later breakdown SELL, no shorting, correct accounting,
 * and run-to-run determinism. The engine is NOT modified to support this.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest } from '../../../src/backtest/index.js';
import { DonchianBreakoutStrategy } from '../../../src/strategy/index.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { btConfig, candle, approveBuy, approveSell, StubRisk, TF } from './helpers.js';

const N = 3;

/** Rising to a breakout, then a crash through the prior low. */
const CLOSES = ['10', '10', '10', '10', '11', '12', '13', '14', '5', '4', '4', '4'];

function run() {
  const candles = CLOSES.map((c, i) => candle(i, Number(c)));
  return runBacktest({
    candles,
    config: btConfig(),
    createStrategy: () => new DonchianBreakoutStrategy(TF, { lookbackPeriod: N }),
    createRiskManager: () =>
      new StubRisk((ctx: RiskContext) => {
        const qty = Money.fromString('1');
        const price = ctx.price ?? Money.fromString('1');
        return ctx.signal.type === 'BUY' ? approveBuy(qty, price) : approveSell(qty, price);
      }),
  });
}

describe('Donchian breakout — backtest integration', () => {
  it('produces a breakout BUY and a later breakdown SELL', () => {
    const result = run();
    expect(result.trades.map((t) => t.side)).toEqual(['BUY', 'SELL']);
    // BUY signal at close[4]=11 fills at next open 12; SELL at close[8]=5 fills at next open 4.
    expect(result.trades[0]!.price.toString()).toBe('12.00000000');
    expect(result.trades[1]!.price.toString()).toBe('4.00000000');
  });

  it('never shorts and never sells before buying', () => {
    const result = run();
    expect(result.trades[0]!.side).toBe('BUY');
    expect(result.trades.every((t) => t.side === 'BUY' || t.side === 'SELL')).toBe(true);
    expect(result.finalPositionQty.isZero()).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  it('keeps portfolio accounting exact', () => {
    const result = run();
    // 10000 - 12 (BUY) + 4 (SELL) = 9992, flat at the end.
    expect(result.finalQuoteCash.toString()).toBe('9992.00000000');
    expect(result.trades[1]!.realizedPnl!.toString()).toBe('-8.00000000');
  });

  it('is deterministic across identical runs', () => {
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
