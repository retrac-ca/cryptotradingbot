import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import {
  evaluateCandleFreshness,
  defaultCandleMaxAgeMs,
  TIMEFRAME_MS,
} from '../../../src/marketdata/candles.js';
import type { Candle } from '../../../src/types.js';

const NOW = 10_000_000;

function candle(endMs: number): Candle {
  const m = Money.fromString('100');
  return {
    symbol: 'BTC/CAD',
    timeframe: '5m',
    timestampMs: endMs,
    open: m,
    high: m,
    low: m,
    close: m,
    baseVolume: Money.zero(),
  };
}

describe('candle-series freshness (P2)', () => {
  it('is fresh when the newest completed candle is within the max age', () => {
    const c = [candle(NOW - 60_000), candle(NOW - 10_000)];
    const r = evaluateCandleFreshness(c, NOW, 60_000);
    expect(r.fresh).toBe(true);
    if (r.fresh) expect(r.newestTimestampMs).toBe(NOW - 10_000);
  });

  it('is stale when the newest completed candle is older than the max age', () => {
    const c = [candle(NOW - 120_000)];
    const r = evaluateCandleFreshness(c, NOW, 60_000);
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('CANDLE_STALE');
  });

  it('fails closed when there is no completed candle', () => {
    const r = evaluateCandleFreshness([], NOW, 60_000);
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('CANDLE_MISSING');
  });

  it('derives a default of three intervals', () => {
    expect(defaultCandleMaxAgeMs('5m')).toBe(3 * TIMEFRAME_MS['5m']);
    expect(defaultCandleMaxAgeMs('1h')).toBe(3 * TIMEFRAME_MS['1h']);
  });
});
