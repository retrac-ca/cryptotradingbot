/**
 * Trend–Pullback–Recovery (TPR) — deterministic backtest integration.
 *
 * Proves the strategy drives the EXISTING backtest engine end-to-end and that
 * the entry anchor observed on the resulting position comes from the DECISION
 * bar's setup, never from the next/fill candle's OHLC.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { runBacktest } from '../../../src/backtest/index.js';
import {
  TrendPullbackRecoveryStrategy,
  type TrendPullbackRecoveryParams,
} from '../../../src/strategy/index.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';
import type { Candle, Timeframe } from '../../../src/types.js';
import { SYMBOL, TF, btConfig, approveBuy, approveSell, StubRisk } from './helpers.js';

const BASE_TS = 1_700_000_000_000;
const SCALE = 1_000_000_000n;

const PARAMS: TrendPullbackRecoveryParams = {
  smaPeriod: 10,
  slopeLookback: 3,
  swingLookback: 10,
  minPullbackFraction: 0.02,
  profitTargetFraction: 0.0125,
};

function at(m: Money, fraction: number): Money {
  return m.mulFraction(BigInt(Math.round(fraction * Number(SCALE))), SCALE);
}

function bar(index: number, o: Money, h: Money, l: Money, cl: Money): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: BASE_TS + index * 300_000,
    open: o,
    high: h,
    low: l,
    close: cl,
    baseVolume: Money.fromNumber(1),
  };
}

/** 19 rising bars (0..18) then the valid pullback/recovery pair (19, 20). */
function tprSeries(): Candle[] {
  const out: Candle[] = [];
  let price = Money.fromNumber(100);
  for (let i = 0; i < 19; i++) {
    if (i > 0) price = at(price, 1.015);
    out.push(bar(i, price, at(price, 1.015), at(price, 0.985), price));
  }
  const peak = out[out.length - 1]!.close;
  out.push(bar(19, at(peak, 1.005), at(peak, 1.01), at(peak, 0.975), at(peak, 0.985)));
  out.push(bar(20, at(peak, 0.985), at(peak, 1.002), at(peak, 0.98), at(peak, 1.0)));
  return out;
}

/**
 * A wrapper that delegates to the real TPR strategy and records the anchor seen
 * in each evaluation's PositionView. It never modifies the anchor.
 */
class RecordingTpr implements Strategy {
  readonly id = 'trend-pullback-recovery';
  readonly name = 'recording-tpr';
  readonly timeframe: Timeframe;
  readonly warmupCandles: number;
  /** The frozen position anchor observed entering each evaluation. */
  readonly anchors: (Money | null)[] = [];
  /** The signal the real TPR strategy produced on each evaluation. */
  readonly signals: Signal[] = [];
  private readonly inner: TrendPullbackRecoveryStrategy;

  constructor(timeframe: Timeframe, params: TrendPullbackRecoveryParams) {
    this.inner = new TrendPullbackRecoveryStrategy(timeframe, params);
    this.timeframe = timeframe;
    this.warmupCandles = this.inner.warmupCandles;
  }

  evaluate(ctx: StrategyContext): Signal {
    this.anchors.push(ctx.position.entryAnchorPrice);
    const sig = this.inner.evaluate(ctx);
    this.signals.push(sig);
    return sig;
  }

  describe(): string {
    return this.inner.describe();
  }
}

function run() {
  const candles = tprSeries();
  const peak = candles[18]!.close;
  // Fill bar (i=21) with an intentionally EXTREME, distinct low and open.
  candles.push(bar(21, peak, at(peak, 1.06), at(peak, 0.5), at(peak, 1.03)));

  let recording: RecordingTpr | null = null;
  const result = runBacktest({
    candles,
    config: btConfig({ initialCash: Money.fromString('100000') }),
    createStrategy: () => {
      recording = new RecordingTpr('5m', PARAMS);
      return recording;
    },
    createRiskManager: () =>
      new StubRisk((ctx) => {
        const qty = Money.fromString('0.01');
        const price = ctx.price ?? Money.fromString('1');
        return ctx.signal.type === 'SELL' ? approveSell(qty, price) : approveBuy(qty, price);
      }),
  });

  return { result, recording: recording as unknown as RecordingTpr, candles };
}

/**
 * Same TPR entry as `run()`, but with an intermediate HOLD fill bar carrying a
 * deep low Q < P, followed by a bar whose close sits between Q and P. Because
 * the structural-anchor exit is evaluated BEFORE the SMA exit and uses the
 * frozen anchor P, that later bar must produce an "entry anchor" SELL; had the
 * fill bar's low Q contaminated the anchor, the same bar would fall through to
 * the SMA exit. A final bar lets the SELL fill so the whole path is pipeline-level.
 */
function runWithLaterDeeperLow() {
  const candles = tprSeries();
  const peak = candles[18]!.close;
  const P = candles[19]!.low; // structural pullback low frozen at the decision bar
  const Q = at(peak, 0.5); // fill-bar extreme low, well below P

  // i = 21: fill bar (BUY fills at its OPEN = peak); close is a no-exit HOLD.
  candles.push(bar(21, peak, at(peak, 1.0), Q, at(peak, 0.99)));
  // i = 22: Q < close < P, above the SMA and below the profit target -> the first
  // matching exit is the structural anchor P.
  candles.push(bar(22, at(peak, 0.95), at(peak, 0.96), at(peak, 0.9), at(peak, 0.9)));
  // i = 23: let the pending SELL from i = 22 fill at this bar's open.
  candles.push(bar(23, at(peak, 0.9), at(peak, 0.91), at(peak, 0.89), at(peak, 0.9)));

  let recording: RecordingTpr | null = null;
  const result = runBacktest({
    candles,
    config: btConfig({ initialCash: Money.fromString('100000') }),
    createStrategy: () => {
      recording = new RecordingTpr('5m', PARAMS);
      return recording;
    },
    createRiskManager: () =>
      new StubRisk((ctx) => {
        const qty = Money.fromString('0.01');
        const price = ctx.price ?? Money.fromString('1');
        return ctx.signal.type === 'SELL' ? approveSell(qty, price) : approveBuy(qty, price);
      }),
  });

  return { result, recording: recording as unknown as RecordingTpr, candles, P, Q };
}

describe('TPR — backtest integration', () => {
  it('drives the existing engine to a BUY fill', () => {
    const { result } = run();
    const buys = result.trades.filter((t) => t.side === 'BUY');
    expect(buys).toHaveLength(1);
    expect(result.rejections).toHaveLength(0);
  });

  it('16. the position anchor comes from the DECISION bar, not the fill candle', () => {
    const { recording, candles } = run();
    const expected = candles[19]!.low; // structural pullback low at the decision bar setup
    const fillBar = candles[21]!;

    const anchorAtFillBar = recording.anchors[21];
    expect(anchorAtFillBar).not.toBeNull();
    expect(anchorAtFillBar!.equals(expected)).toBe(true);

    // The fill candle's own extremes are different and must NOT be the anchor.
    expect(anchorAtFillBar!.equals(fillBar.low)).toBe(false);
    expect(anchorAtFillBar!.equals(fillBar.open)).toBe(false);
    expect(fillBar.low.equals(expected)).toBe(false);
  });

  it('17. a deep fill-bar low never becomes or modifies the entry anchor', () => {
    const { recording, candles, P, Q } = runWithLaterDeeperLow();
    const fillBar = candles[21]!;

    // The fill bar genuinely has an extreme low below the structural anchor.
    expect(fillBar.low.equals(Q)).toBe(true);
    expect(Q.compareTo(P)).toBeLessThan(0);

    // The anchor stays exactly P on the fill bar and on every later bar.
    expect(recording.anchors[21]!.equals(P)).toBe(true);
    expect(recording.anchors[22]!.equals(P)).toBe(true);
    expect(recording.anchors[22]!.equals(Q)).toBe(false);
    expect(recording.anchors[21]!.equals(fillBar.low)).toBe(false);
    expect(recording.anchors[21]!.equals(fillBar.open)).toBe(false);
  });

  it('18. a subsequent structural SELL uses the frozen anchor P, not the fill-bar low Q', () => {
    const { result, recording, P } = runWithLaterDeeperLow();

    // The fill bar itself produces no exit.
    expect(recording.signals[21]!.type).toBe('HOLD');

    // With the frozen P, close < P triggers the structural exit. Had the fill-bar
    // low Q contaminated the anchor, close > Q would skip the anchor branch and
    // fall through to the SMA exit (a different reason), so the reason discriminates.
    const sell = recording.signals[22]!;
    expect(sell.type).toBe('SELL');
    expect(sell.reason).toMatch(/entry anchor/);

    // End-to-end: the engine turns that decision into a SELL fill on the next bar.
    const sells = result.trades.filter((t) => t.side === 'SELL');
    expect(sells).toHaveLength(1);
    expect(sells[0]!.signalBarIndex).toBe(22);
    expect(recording.anchors[22]!.equals(P)).toBe(true);
  });

  it('is deterministic across identical runs', () => {
    expect(JSON.stringify(run().result)).toBe(JSON.stringify(run().result));
  });
});
