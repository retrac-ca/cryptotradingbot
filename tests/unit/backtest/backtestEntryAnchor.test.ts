/**
 * Focused tests proving the entry anchor is carried from the DECISION bar's
 * signal onto the resulting backtest position, and that the FILL bar's OHLC can
 * never change the stored anchor.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { signal } from '../../../src/strategy/Signal.js';
import { runBacktest } from '../../../src/backtest/engine.js';
import { StubRisk, approveBuy, btConfig, candle } from './helpers.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';

const QTY = Money.fromString('0.1');

interface Captured {
  bar: number;
  anchor: Money | null;
}

/**
 * A scripted strategy that emits a BUY with `anchor` on bar 0 and HOLD
 * afterwards, recording the PositionView anchor it observes on every bar.
 */
function anchorStrategy(anchor: Money, captured: Captured[]): Strategy {
  let bar = 0;
  return {
    id: 'anchor-test',
    name: 'anchor-test',
    timeframe: '1d',
    warmupCandles: 0,
    evaluate(ctx: StrategyContext): Signal {
      const current = bar++;
      captured.push({ bar: current, anchor: ctx.position.entryAnchorPrice });
      if (current === 0) {
        return signal(ctx.symbol, 'BUY', { reason: 'entry', entryAnchorPrice: anchor }, ctx.nowMs);
      }
      return signal(ctx.symbol, 'HOLD', {}, ctx.nowMs);
    },
    describe: () => 'anchor-test',
  };
}

function run(anchor: Money, candles: ReturnType<typeof candle>[], captured: Captured[], initialCash = '100000') {
  return runBacktest({
    candles,
    config: btConfig({ initialCash: Money.fromString(initialCash) }),
    createStrategy: () => anchorStrategy(anchor, captured),
    createRiskManager: () => new StubRisk(() => approveBuy(QTY, Money.fromString('100'))),
  });
}

describe('Backtest entry anchor', () => {
  it('carries the signal anchor from the decision bar onto the resulting position', () => {
    const anchor = Money.fromString('12345');
    const captured: Captured[] = [];
    const res = run(anchor, [candle(0, 100, 100), candle(1, 100, 100), candle(2, 100, 100), candle(3, 100, 100)], captured);

    expect(res.trades).toHaveLength(1);
    expect(res.trades[0]!.signalBarIndex).toBe(0);

    // The bar AFTER the decision (where the fill lands) observes the frozen
    // anchor through the PositionView.
    const atFillBar = captured.find((c) => c.bar === 1)!;
    expect(atFillBar.anchor).not.toBeNull();
    expect(atFillBar.anchor!.equals(anchor)).toBe(true);
  });

  it('proves the fill bar OHLC cannot change the stored anchor', () => {
    const anchor = Money.fromString('111');
    const fillOpen = Money.fromString('88888');
    const captured: Captured[] = [];
    const fillBar = { ...candle(1, 88888, 88888), open: fillOpen, high: fillOpen, low: fillOpen, close: fillOpen };
    const res = run(anchor, [candle(0, 100, 100), fillBar, candle(2, 88888, 88888)], captured);

    expect(res.trades).toHaveLength(1);
    // The fill genuinely used the fill bar's open...
    expect(res.trades[0]!.price.equals(fillOpen)).toBe(true);

    // ...but the stored anchor is the DECISION-time anchor, never the fill price.
    const atFillBar = captured.find((c) => c.bar === 1)!;
    expect(atFillBar.anchor!.equals(anchor)).toBe(true);
    expect(atFillBar.anchor!.equals(fillOpen)).toBe(false);
  });

  it('stores null when the signal did not carry an anchor', () => {
    const captured: Captured[] = [];
    let bar = 0;
    const strategy: Strategy = {
      id: 'no-anchor',
      name: 'no-anchor',
      timeframe: '1d',
      warmupCandles: 0,
      evaluate(ctx: StrategyContext): Signal {
        const current = bar++;
        captured.push({ bar: current, anchor: ctx.position.entryAnchorPrice });
        return current === 0
          ? signal(ctx.symbol, 'BUY', { reason: 'entry' }, ctx.nowMs)
          : signal(ctx.symbol, 'HOLD', {}, ctx.nowMs);
      },
      describe: () => 'no-anchor',
    };
    const res = runBacktest({
      candles: [candle(0, 100, 100), candle(1, 100, 100), candle(2, 100, 100)],
      config: btConfig({ initialCash: Money.fromString('100000') }),
      createStrategy: () => strategy,
      createRiskManager: () => new StubRisk(() => approveBuy(QTY, Money.fromString('100'))),
    });
    expect(res.trades).toHaveLength(1);
    expect(captured.find((c) => c.bar === 1)!.anchor).toBeNull();
  });
});
