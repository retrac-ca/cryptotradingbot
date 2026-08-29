import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { MovingAverageCrossoverStrategy } from '../../../src/strategy/movingAverageCrossover.js';
import type { Candle, Timeframe } from '../../../src/types.js';
import type { StrategyContext, PositionView } from '../../../src/strategy/StrategyContext.js';

const TF: Timeframe = '5m';

const candle = (close: string, tsMs: number): Candle => ({
  symbol: 'BTC/CAD',
  timeframe: TF,
  timestampMs: tsMs,
  open: Money.fromString(close),
  high: Money.fromString(close),
  low: Money.fromString(close),
  close: Money.fromString(close),
  baseVolume: Money.fromString('1'),
});

// Build a context. `closes` are the last candles (oldest first). `fastAbove`
// controls the price path so that the fast MA is above/below the slow MA at the
// end. We craft candle series whose close path makes fast cross slow.
const context = (
  closes: string[],
  opts: { quantity?: string; insufficientData?: boolean; now?: number } = {},
): StrategyContext => {
  const candles = closes.map((c, i) => candle(c, 1_000_000 + i * 300_000));
  const position: PositionView = {
    symbol: 'BTC/CAD',
    quantity: opts.quantity ? Money.fromString(opts.quantity) : Money.zero(),
    averageEntryPrice: null,
    realizedPnl: Money.zero(),
  };
  return {
    nowMs: opts.now ?? 5_000_000,
    symbol: 'BTC/CAD',
    ticker: null,
    candles,
    timeframe: TF,
    position,
    insufficientData: opts.insufficientData ?? false,
  };
};

describe('MovingAverageCrossoverStrategy', () => {
  it('is deterministic for the same snapshot across two instances', () => {
    const a = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    const b = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    const closes = ['1', '2', '3', '4', '5', '6', '7'];
    const ca = context(closes);
    expect(a.evaluate(ca).type).toBe(b.evaluate(ca).type);
  });

  it('returns HOLD with insufficient data', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    // warmupCandles = slowPeriod + 1 = 4
    expect(s.warmupCandles).toBe(4);
    const sig = s.evaluate(context(['1', '2', '3'], { insufficientData: true }));
    expect(sig.type).toBe('HOLD');
  });

  it('returns HOLD when the candle series is shorter than warmup', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    expect(s.evaluate(context(['1', '2'])).type).toBe('HOLD');
  });

  it('does not emit a signal on the first warm evaluation (records state)', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    // slow(3) uses last 3 closes, fast(2) uses last 2. All flat => fast===slow===3
    const sig = s.evaluate(context(['3', '3', '3', '3', '3', '3']));
    expect(sig.type).toBe('HOLD');
  });

  it('emits BUY on a golden cross while flat', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    // Baseline: steady decline -> fast(2) BELOW slow(3)
    const baseline = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5'];
    s.evaluate(context(baseline)); // establish fast-below-slow state
    // Sharp rally -> fast(2) crosses ABOVE slow(3)
    const golden = context([...baseline, '30']);
    const sig = s.evaluate(golden);
    expect(sig.type).toBe('BUY');
    expect(sig.symbol).toBe('BTC/CAD');
  });

  it('does not emit BUY on a golden cross when already long (no stacking)', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    const baseline = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5'];
    s.evaluate(context(baseline));
    const longCtx = context([...baseline, '30'], { quantity: '0.5' });
    expect(s.evaluate(longCtx).type).toBe('HOLD');
  });

  it('emits SELL on a death cross while long', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    // Baseline: steady advance -> fast(2) ABOVE slow(3)
    const baseline = ['6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10'];
    s.evaluate(context(baseline)); // establish fast-above-slow state
    // Sharp drop -> fast(2) crosses BELOW slow(3)
    const death = context([...baseline, '4'], { quantity: '0.5' });
    const sig = s.evaluate(death);
    expect(sig.type).toBe('SELL');
  });

  it('does not emit SELL on a death cross when flat', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    const baseline = ['6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10'];
    s.evaluate(context(baseline));
    const flatDeath = context([...baseline, '4']); // no position
    expect(s.evaluate(flatDeath).type).toBe('HOLD');
  });

  it('does not re-emit BUY on subsequent ticks while fast stays above', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    const baseline = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6.5'];
    s.evaluate(context(baseline));
    const crosses = context([...baseline, '30']);
    expect(s.evaluate(crosses).type).toBe('BUY');
    // Fast stays above with more rising candles -> HOLD, not another BUY.
    expect(s.evaluate(context([...baseline, '30', '31', '32'])).type).toBe('HOLD');
  });

  it('rejects invalid period combinations', () => {
    expect(() => new MovingAverageCrossoverStrategy(TF, { fastPeriod: 5, slowPeriod: 5 })).toThrow();
    expect(() => new MovingAverageCrossoverStrategy(TF, { fastPeriod: 30, slowPeriod: 10 })).toThrow();
    expect(() => new MovingAverageCrossoverStrategy(TF, { fastPeriod: 0, slowPeriod: 3 })).toThrow();
  });

  it('exposes meta about itself', () => {
    const s = new MovingAverageCrossoverStrategy(TF, { fastPeriod: 2, slowPeriod: 3 });
    expect(s.id).toBe('moving-average-crossover');
    expect(s.name).toContain('Moving Average');
    expect(s.describe()).toContain('fast=2');
    expect(s.describe()).toContain('slow=3');
  });
});
