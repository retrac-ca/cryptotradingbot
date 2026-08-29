import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { LiveMarketData } from '../../../src/marketdata/LiveMarketData.js';
import { Money } from '../../../src/money/Money.js';
import type { Candle, OrderBook, Ticker } from '../../../src/types.js';

const mkTicker = (symbol: string, last: string, tsMs: number): Ticker => ({
  symbol,
  bid: Money.fromString(last),
  ask: Money.fromString(last),
  last: Money.fromString(last),
  open: null,
  high: null,
  low: null,
  baseVolume: null,
  quoteVolume: null,
  timestampMs: tsMs,
});

const mkBook = (symbol: string, tsMs: number): OrderBook => ({
  symbol,
  timestampMs: tsMs,
  bids: [{ price: Money.fromString('108000'), quantity: Money.fromString('0.5') }],
  asks: [{ price: Money.fromString('108050'), quantity: Money.fromString('0.4') }],
});

const mkCandles = (symbol: string, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    symbol,
    timeframe: '5m' as const,
    timestampMs: 1_000_000 + i * 300_000,
    open: Money.fromString('100'),
    high: Money.fromString('101'),
    low: Money.fromString('99'),
    close: Money.fromString('100.5'),
    baseVolume: Money.fromString('1'),
  }));

const eq = (got: Money | null, want: string): void => {
  expect(got?.equals(Money.fromString(want)) ?? false).toBe(true);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveMarketData', () => {
  it('fetches initial snapshots for all kinds on start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({
      tickers: { 'BTC/CAD': mkTicker('BTC/CAD', '108000', 5_000_000) },
      orderBooks: { 'BTC/CAD': mkBook('BTC/CAD', 5_000_000) },
      candles: { 'BTC/CAD': mkCandles('BTC/CAD', 3) },
    });
    const md = new LiveMarketData(ex, {
      symbols: ['BTC/CAD'],
      tickerIntervalMs: 100,
      orderBookIntervalMs: 200,
      candleTimeframes: ['5m'],
      candleIntervalMs: 1000,
    });
    await md.start();

    eq(md.getTicker('BTC/CAD')?.last, '108000');
    eq(md.getOrderBook('BTC/CAD')?.bids[0]?.price, '108000');
    expect(md.getCandles('BTC/CAD', '5m')).toHaveLength(3);
    expect(md.isStale('ticker', 'BTC/CAD')).toBe(false);
    md.stop();
  });

  it('polls tickers on cadence and emits events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ tickers: { 'BTC/CAD': mkTicker('BTC/CAD', '108000', 5_000_000) } });
    const md = new LiveMarketData(ex, { symbols: ['BTC/CAD'], tickerIntervalMs: 1000, orderBookIntervalMs: 0 });
    const seen: Ticker[] = [];
    md.events.on('ticker', (t) => seen.push(t));
    await md.start();

    ex.setTicker('BTC/CAD', { last: Money.fromString('109000'), bid: Money.fromString('109000'), ask: Money.fromString('109000'), timestampMs: 6_000_000 });

    await vi.advanceTimersByTimeAsync(1000);
    eq(md.getTicker('BTC/CAD')?.last, '109000');
    expect(seen.some((x) => x.last.equals(Money.fromString('109000')))).toBe(true);
    md.stop();
  });

  it('reports stale before first fetch and after the tolerance window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ tickers: { 'BTC/CAD': mkTicker('BTC/CAD', '108000', 5_000_000) } });
    // Polling disabled for tickers; freshness only advances on refresh(). This
    // isolates the staleness logic (with active polling it naturally stays fresh).
    const md = new LiveMarketData(ex, { symbols: ['BTC/CAD'], tickerIntervalMs: 0, staleAfterMs: 500 });

    expect(md.isStale('ticker', 'BTC/CAD')).toBe(true);
    await md.start();

    await md.refresh('ticker', 'BTC/CAD');
    expect(md.isStale('ticker', 'BTC/CAD')).toBe(false);

    // Simulate a gap: only the tolerance window passes without a refresh.
    await vi.advanceTimersByTimeAsync(300);
    expect(md.isStale('ticker', 'BTC/CAD')).toBe(false);

    await vi.advanceTimersByTimeAsync(250); // total 550ms > 500 staleAfterMs
    expect(md.isStale('ticker', 'BTC/CAD')).toBe(true);
    md.stop();
  });

  it('keeps the last snapshot and recovers after a transient failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ tickers: { 'BTC/CAD': mkTicker('BTC/CAD', '108000', 5_000_000) } });
    const md = new LiveMarketData(ex, { symbols: ['BTC/CAD'], tickerIntervalMs: 100, orderBookIntervalMs: 0 });
    const errors: Error[] = [];
    md.events.on('failure', (ev) => errors.push(ev.error));
    await md.start();

    ex.setFailures({ getTicker: { kind: 'network' } });
    await vi.advanceTimersByTimeAsync(100);
    expect(md.lastError('ticker', 'BTC/CAD')).toBeInstanceOf(Error);
    expect(md.consecutiveFailures('ticker', 'BTC/CAD')).toBe(1);
    // Previous snapshot retained.
    eq(md.getTicker('BTC/CAD')?.last, '108000');
    expect(errors).toHaveLength(1);

    ex.setFailures({});
    await vi.advanceTimersByTimeAsync(100);
    expect(md.consecutiveFailures('ticker', 'BTC/CAD')).toBe(0);
    expect(md.lastError('ticker', 'BTC/CAD')).toBeNull();
    md.stop();
  });

  it('refresh() fetches on demand even when polling is disabled for a kind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ candles: { 'BTC/CAD': mkCandles('BTC/CAD', 5) } });
    const md = new LiveMarketData(ex, { symbols: ['BTC/CAD'], candleTimeframes: ['5m'], candleIntervalMs: 0 });

    expect(md.getCandles('BTC/CAD', '5m')).toHaveLength(0);
    await md.refresh('candles', 'BTC/CAD', '5m');
    expect(md.getCandles('BTC/CAD', '5m')).toHaveLength(5);
    expect(md.lastUpdatedMs('candles', 'BTC/CAD', '5m')).not.toBeNull();
    md.stop();
  });

  it('stop() prevents further polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const ex = new FakeExchange({ tickers: { 'BTC/CAD': mkTicker('BTC/CAD', '108000', 5_000_000) } });
    const md = new LiveMarketData(ex, { symbols: ['BTC/CAD'], tickerIntervalMs: 100, orderBookIntervalMs: 0 });
    await md.start();

    md.stop();
    ex.setTicker('BTC/CAD', { last: Money.fromString('200000'), bid: Money.fromString('200000'), ask: Money.fromString('200000'), timestampMs: 7_000_000 });
    await vi.advanceTimersByTimeAsync(500);
    eq(md.getTicker('BTC/CAD')?.last, '108000');
  });
});