import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { sma, ema } from '../../../src/strategy/indicators.js';
import type { Candle } from '../../../src/types.js';

const candle = (close: string, tsMs: number): Candle => ({
  symbol: 'BTC/CAD',
  timeframe: '5m',
  timestampMs: tsMs,
  open: Money.fromString(close),
  high: Money.fromString(close),
  low: Money.fromString(close),
  close: Money.fromString(close),
  baseVolume: Money.fromString('1'),
});

const series = (closes: string[], start = 0): Candle[] =>
  closes.map((c, i) => candle(c, start + i * 300_000));

describe('sma', () => {
  it('returns null when there are fewer candles than the period', () => {
    expect(sma(series(['1', '2', '3']), 4)).toBeNull();
  });

  it('returns null for a non-positive period', () => {
    expect(sma(series(['1', '2', '3']), 0)).toBeNull();
  });

  it('computes a simple moving average over the last N closes', () => {
    const s = series(['1', '3', '5', '7', '9']);
    // Last 3 closes: 5, 7, 9 -> avg 7
    expect(sma(s, 3)?.equals(Money.fromString('7'))).toBe(true);
    // Last 2 closes: 7, 9 -> avg 8
    expect(sma(s, 2)?.equals(Money.fromString('8'))).toBe(true);
  });

  it('handles fractional averages exactly', () => {
    const s = series(['1', '2', '4']);
    // (1+2+4)/3 = 2.33333333
    expect(sma(s, 3)?.toFixed(8)).toBe('2.33333333');
  });

  it('returns null on an empty series', () => {
    expect(sma([], 3)).toBeNull();
  });
});

describe('ema', () => {
  it('returns null for a non-positive period', () => {
    expect(ema(series(['1', '2']), 0)).toBeNull();
  });

  it('returns null on an empty series', () => {
    expect(ema([], 5)).toBeNull();
  });

  it('falls back to SMA when there is not enough data to seed', () => {
    const s = series(['1', '2', '3']);
    expect(ema(s, 5)?.equals(Money.fromString('2'))).toBe(true); // avg of all three
  });

  it('computes an EMA seeded by an SMA over the seed window', () => {
    const s = series(['10', '11', '12', '13', '14', '15']);
    // Seed with SMA over first 3: (10+11+12)/3 = 11.
    // alpha = 2/(3+1) = 0.5 for period 3.
    // e = 11
    // i=3 (13): 13*0.5 + 11*0.5 = 12
    // i=4 (14): 14*0.5 + 12*0.5 = 13
    // i=5 (15): 15*0.5 + 13*0.5 = 14
    expect(ema(s, 3, 3)?.toFixed(8)).toBe('14.00000000');
  });

  it('weighs recent values more heavily than old ones', () => {
    // A jump near the end pulls the EMA up more than the SMA.
    const s = series(['10', '10', '10', '10', '30']);
    const e = ema(s, 3, 3)!;
    const m = sma(s, 3)!; // last 3: 10,10,30 -> 16.66666667
    expect(e.compareTo(m)).toBeGreaterThan(0);
  });
});
