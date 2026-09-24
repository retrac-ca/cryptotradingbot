import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import {
  MeanReversionStrategy,
  DEFAULT_MEAN_REVERSION_PERIOD,
  DEFAULT_MEAN_REVERSION_DEVIATION,
  createStrategy,
} from '../../../src/strategy/index.js';
import type { Candle, Timeframe } from '../../../src/types.js';
import type { StrategyContext, PositionView } from '../../../src/strategy/StrategyContext.js';

const TF: Timeframe = '5m';
const WARMUP = DEFAULT_MEAN_REVERSION_PERIOD + 1; // 49

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

const context = (
  closes: string[],
  opts: { quantity?: string; insufficientData?: boolean; now?: number } = {},
): StrategyContext => {
  const candles = closes.map((c, i) => candle(c, 1_000_000 + i * 300_000));
  const position: PositionView = {
    symbol: 'BTC/CAD',
    quantity: opts.quantity ? Money.fromString(opts.quantity) : Money.zero(),
    averageEntryPrice: opts.quantity ? Money.fromString('100') : null,
    entryAnchorPrice: null,
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

const strategy = () =>
  new MeanReversionStrategy(TF, {
    period: DEFAULT_MEAN_REVERSION_PERIOD,
    deviationThreshold: DEFAULT_MEAN_REVERSION_DEVIATION,
  });

/**
 * 49 candles whose LAST 48 are 47 x `base` followed by `last`.
 * (The leading candle is outside the 48-bar window and is ignored.)
 * Solving (MA - last)/MA = 0.015 with base 94.03 gives last = 92.59 exactly at
 * the boundary.
 */
const boundarySeries = (last: string, base = '94.03') => [...Array(48).fill(base), last];

describe('MeanReversionStrategy', () => {
  describe('warmup', () => {
    it('has warmupCandles = period + 1 = 49', () => {
      expect(strategy().warmupCandles).toBe(WARMUP);
    });

    it('returns HOLD when insufficientData is flagged', () => {
      expect(strategy().evaluate(context(boundarySeries('92.59'), { insufficientData: true })).type).toBe('HOLD');
    });

    it('is not eligible with only 48 candles even if price is extended', () => {
      // 48 candles: [47 x 100, 98.4] -> last-48 window is the same as the 49-candle
      // case below, but warmup is not met.
      const short = [...Array(47).fill('100'), '98.4'];
      expect(short.length).toBe(48);
      expect(strategy().evaluate(context(short)).type).toBe('HOLD');
    });

    it('becomes eligible at exactly 49 candles', () => {
      // 49 candles, last window = 47 x 100 + 98.4 -> ~1.567% below MA -> BUY.
      const eligible = [...Array(48).fill('100'), '98.4'];
      expect(eligible.length).toBe(49);
      expect(strategy().evaluate(context(eligible)).type).toBe('BUY');
    });
  });

  describe('exact 1.5% entry threshold', () => {
    it('does not BUY just below the threshold (~1.4%)', () => {
      // last = 92.60 -> deviation ~1.49% < 1.5% -> HOLD.
      expect(strategy().evaluate(context(boundarySeries('92.60'))).type).toBe('HOLD');
    });

    it('BUYs exactly at the 1.5% threshold', () => {
      // last = 92.59 -> (MA - close)/MA == 0.015 exactly -> BUY.
      expect(strategy().evaluate(context(boundarySeries('92.59'))).type).toBe('BUY');
    });

    it('BUYs above the threshold', () => {
      expect(strategy().evaluate(context(boundarySeries('90.00'))).type).toBe('BUY');
    });

    it('emits a clear reason on entry', () => {
      const sig = strategy().evaluate(context(boundarySeries('90.00')));
      expect(sig.reason).toContain('MA48');
    });
  });

  describe('moving-average calculation', () => {
    it('includes the current candle in the MA48 window', () => {
      // 49 candles: leading 100 ignored; last window = 47 x 100 + 98.5.
      // With the current close included the deviation is ~1.469% -> HOLD.
      // If the current candle were EXCLUDED, MA48 would be 100 and deviation
      // would be exactly 1.5% -> BUY. HOLD proves inclusion.
      const closes = [...Array(48).fill('100'), '98.5'];
      expect(strategy().evaluate(context(closes)).type).toBe('HOLD');
    });

    it('uses exactly the last 48 closes (an older outlier is ignored)', () => {
      // 49 candles: 1000 then 48 x 100. Last 48 closes are all 100 -> deviation 0
      // -> HOLD. If the outlier were included in the average, price would be far
      // below the inflated MA and the strategy would BUY.
      const closes = ['1000', ...Array(48).fill('100')];
      expect(strategy().evaluate(context(closes)).type).toBe('HOLD');
    });
  });

  describe('exit', () => {
    it('HOLDs while long and still below the MA', () => {
      const closes = [...Array(48).fill('100'), '97'];
      expect(strategy().evaluate(context(closes, { quantity: '0.5' })).type).toBe('HOLD');
    });

    it('SELLs when close is exactly at the MA', () => {
      const closes = [...Array(49).fill('100')];
      expect(strategy().evaluate(context(closes, { quantity: '0.5' })).type).toBe('SELL');
    });

    it('SELLs when close is above the MA', () => {
      const closes = [...Array(48).fill('100'), '102'];
      expect(strategy().evaluate(context(closes, { quantity: '0.5' })).type).toBe('SELL');
    });
  });

  describe('long-only behavior', () => {
    it('does not SELL while flat', () => {
      const closes = [...Array(48).fill('100'), '102'];
      expect(strategy().evaluate(context(closes)).type).toBe('HOLD');
    });

    it('does not BUY while already long (no pyramiding)', () => {
      expect(strategy().evaluate(context(boundarySeries('90.00'), { quantity: '0.5' })).type).toBe('HOLD');
    });
  });

  describe('no strategy-specific stop-loss', () => {
    it('HOLDs a deeply underwater long (the strategy applies no stop)', () => {
      // A 20% drawdown from the MA would trigger a typical stop; this strategy
      // must simply HOLD until price reverts to/above the MA.
      const closes = [...Array(48).fill('100'), '80'];
      expect(strategy().evaluate(context(closes, { quantity: '0.5' })).type).toBe('HOLD');
    });

    it('does not mention a stop in its description', () => {
      expect(strategy().describe().toLowerCase()).not.toContain('stop');
    });
  });

  describe('no lookahead', () => {
    it('a prefix decision is unaffected by later candles', () => {
      const s = strategy();
      const prefix = boundarySeries('92.59');
      const before = s.evaluate(context(prefix)).type;
      // Evaluate a longer series that shares the prefix; the prefix signal must
      // remain identical and derivable from the prefix alone.
      s.evaluate(context([...prefix, '500', '500']));
      const after = strategy().evaluate(context(prefix)).type;
      expect(before).toBe('BUY');
      expect(after).toBe(before);
    });

    it('does not depend on evaluation order', () => {
      const s = strategy();
      expect(s.evaluate(context(boundarySeries('90.00'))).type).toBe('BUY');
      expect(s.evaluate(context([...Array(49).fill('100')], { quantity: '0.5' })).type).toBe('SELL');
    });
  });

  describe('determinism', () => {
    it('fresh instances produce identical signals for identical context', () => {
      const closes = boundarySeries('90.00');
      const a = strategy().evaluate(context(closes));
      const b = strategy().evaluate(context(closes));
      expect(a.type).toBe(b.type);
      expect(a.reason).toBe(b.reason);
    });
  });

  describe('description and registration', () => {
    it('identifies the strategy and pre-registered parameters', () => {
      const s = strategy();
      expect(s.id).toBe('mean-reversion');
      expect(s.describe()).toBe('mean-reversion(period=48, deviation=0.015)');
    });

    it('registers with the pre-registered defaults', () => {
      const s = createStrategy('mean-reversion', { timeframe: TF }) as MeanReversionStrategy;
      expect(s.id).toBe('mean-reversion');
      expect(s.period).toBe(48);
      expect(s.deviationThreshold).toBe(0.015);
      expect(s.warmupCandles).toBe(49);
    });

    it('rejects invalid parameters', () => {
      expect(() => new MeanReversionStrategy(TF, { period: 0, deviationThreshold: 0.015 })).toThrow();
      expect(() => new MeanReversionStrategy(TF, { period: 48, deviationThreshold: 0 })).toThrow();
      expect(() => new MeanReversionStrategy(TF, { period: 48, deviationThreshold: 1 })).toThrow();
    });
  });
});
