/**
 * F4 — candle warmup window.
 *
 * The NDAX adapter's fixed ~24h default is too short to warm up the strategy on
 * timeframes >= 1h. The lookback is derived generically from the timeframe and
 * the strategy's warmup requirement, and forwarded to the adapter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveMarketData } from '../../../src/marketdata/LiveMarketData.js';
import { requiredCandleLookbackMs, TIMEFRAME_MS } from '../../../src/marketdata/candles.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { Money } from '../../../src/money/Money.js';
import type { Candle } from '../../../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

const mkCandles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol: 'BTC/CAD',
    timeframe: '1h' as const,
    timestampMs: 1_000_000 + i * 3_600_000,
    open: Money.fromString('100'),
    high: Money.fromString('100'),
    low: Money.fromString('100'),
    close: Money.fromString('100'),
    baseVolume: Money.fromString('1'),
  }));

describe('F4 — requiredCandleLookbackMs', () => {
  it('covers the warmup requirement on every timeframe (with margin)', () => {
    for (const tf of ['5m', '1h', '4h', '1d'] as const) {
      const warmup = 31;
      const lookback = requiredCandleLookbackMs(tf, warmup);
      expect(lookback).toBeGreaterThan(warmup * TIMEFRAME_MS[tf]);
    }
  });

  it('produces a window larger than the old fixed ~24h for 1h/4h/1d', () => {
    const day = 24 * 3_600_000;
    expect(requiredCandleLookbackMs('1h', 31)).toBeGreaterThan(day);
    expect(requiredCandleLookbackMs('4h', 31)).toBeGreaterThan(day);
    expect(requiredCandleLookbackMs('1d', 31)).toBeGreaterThan(day);
  });

  it('handles a zero/odd warmup without collapsing to zero', () => {
    expect(requiredCandleLookbackMs('1h', 0)).toBeGreaterThan(0);
  });
});

describe('F4 — LiveMarketData forwards the derived lookback', () => {
  it('requests candles with an explicit fromMs/toMs when candleLookbackMs is set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ candles: { 'BTC/CAD': mkCandles(40) } });
    const spy = vi.spyOn(ex, 'getCandles');
    const lookback = requiredCandleLookbackMs('1h', 31);

    const md = new LiveMarketData(ex, {
      symbols: ['BTC/CAD'],
      candleTimeframes: ['1h'],
      candleIntervalMs: 1000,
      candleLookbackMs: lookback,
    });
    await md.start();

    expect(spy).toHaveBeenCalled();
    const opts = spy.mock.calls[0]![2];
    expect(opts).toBeDefined();
    expect(opts!.fromMs).toBe(5_000_000 - lookback);
    expect(opts!.toMs).toBe(5_000_000);
    expect(md.getCandles('BTC/CAD', '1h')).toHaveLength(40);
    md.stop();
  });

  it('does not invent opts when candleLookbackMs is not configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ candles: { 'BTC/CAD': mkCandles(3) } });
    const spy = vi.spyOn(ex, 'getCandles');
    const md = new LiveMarketData(ex, {
      symbols: ['BTC/CAD'],
      candleTimeframes: ['1h'],
      candleIntervalMs: 1000,
    });
    await md.start();
    expect(spy.mock.calls[0]![2]).toBeUndefined();
    md.stop();
  });
});
