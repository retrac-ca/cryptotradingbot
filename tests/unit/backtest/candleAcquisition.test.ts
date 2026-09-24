/**
 * Historical candle acquisition tests — no network. Uses a stub adapter that
 * only implements `getCandles` (trading methods throw if ever called).
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { acquireCandles, candlesToRows } from '../../../src/backtest/index.js';
import type { ExchangeAdapter } from '../../../src/exchanges/ExchangeAdapter.js';
import type { Candle, Timeframe } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '1h';
const BAR_MS = 3_600_000;
const BASE = 1_700_000_000_000;

function candle(ts: number, close = '100', over: Partial<Candle> = {}): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: ts,
    open: Money.fromString(close),
    high: Money.fromString(close),
    low: Money.fromString(close),
    close: Money.fromString(close),
    baseVolume: Money.fromString('1'),
    ...over,
  };
}

interface Call {
  symbol: string;
  timeframe: Timeframe;
  fromMs?: number;
  toMs?: number;
}

/** Minimal adapter: only getCandles is real; trading methods fail loudly. */
class StubAdapter {
  readonly calls: Call[] = [];
  constructor(private readonly series: Candle[], private readonly ignoreRange = false) {}

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<Candle[]> {
    this.calls.push({ symbol, timeframe, fromMs: opts?.fromMs, toMs: opts?.toMs });
    if (this.ignoreRange) return this.series;
    const from = opts?.fromMs ?? Number.NEGATIVE_INFINITY;
    const to = opts?.toMs ?? Number.POSITIVE_INFINITY;
    return this.series.filter((c) => c.timestampMs >= from && c.timestampMs <= to);
  }

  async placeOrder(): Promise<never> {
    throw new Error('placeOrder must never be called by candle acquisition');
  }
  async cancelOrder(): Promise<never> {
    throw new Error('cancelOrder must never be called by candle acquisition');
  }
  async getBalances(): Promise<never> {
    throw new Error('getBalances must never be called by candle acquisition');
  }
}

function asAdapter(stub: StubAdapter): ExchangeAdapter {
  return stub as unknown as ExchangeAdapter;
}

/**
 * Adapter that returns a scripted sequence of page responses (one entry per
 * call, clamped to the last entry). Lets a test simulate NDAX's intermittent
 * empty and non-empty truncated-tail responses deterministically.
 */
class ScriptedAdapter {
  readonly calls: Call[] = [];
  private index = 0;
  constructor(private readonly responses: Candle[][]) {}

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<Candle[]> {
    this.calls.push({ symbol, timeframe, fromMs: opts?.fromMs, toMs: opts?.toMs });
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? [];
    if (this.index < this.responses.length - 1) this.index += 1;
    return response;
  }

  async placeOrder(): Promise<never> {
    throw new Error('placeOrder must never be called by candle acquisition');
  }
  async cancelOrder(): Promise<never> {
    throw new Error('cancelOrder must never be called by candle acquisition');
  }
  async getBalances(): Promise<never> {
    throw new Error('getBalances must never be called by candle acquisition');
  }
}

describe('acquireCandles', () => {
  it('sorts chronologically and serializes exact decimal values', async () => {
    const series = [candle(BASE + 2 * BAR_MS, '102'), candle(BASE, '100'), candle(BASE + BAR_MS, '101')];
    const stub = new StubAdapter(series);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 2 * BAR_MS,
    });
    expect(result.candles.map((c) => c.timestampMs)).toEqual([BASE, BASE + BAR_MS, BASE + 2 * BAR_MS]);
    const rows = candlesToRows(result.candles);
    expect(rows[0]).toEqual({
      symbol: SYMBOL,
      timeframe: TF,
      timestampMs: BASE,
      open: '100.00000000',
      high: '100.00000000',
      low: '100.00000000',
      close: '100.00000000',
      baseVolume: '1.00000000',
    });
  });

  it('rejects duplicate timestamps instead of deduplicating', async () => {
    const stub = new StubAdapter([candle(BASE), candle(BASE), candle(BASE + BAR_MS)]);
    await expect(
      acquireCandles(asAdapter(stub), { symbol: SYMBOL, timeframe: TF, fromMs: BASE, toMs: BASE + BAR_MS }),
    ).rejects.toThrow(/duplicate candle timestamp/);
  });

  it('rejects malformed OHLC data', async () => {
    const bad = candle(BASE, '100', { high: Money.fromString('90') });
    const stub = new StubAdapter([bad]);
    await expect(
      acquireCandles(asAdapter(stub), { symbol: SYMBOL, timeframe: TF, fromMs: BASE, toMs: BASE + BAR_MS }),
    ).rejects.toThrow(/invalid candle data/);
  });

  it('rejects an empty result', async () => {
    const stub = new StubAdapter([]);
    await expect(
      acquireCandles(asAdapter(stub), { symbol: SYMBOL, timeframe: TF, fromMs: BASE, toMs: BASE + BAR_MS }),
    ).rejects.toThrow(/no candles returned/);
  });

  it('forwards the requested timeframe and bounded, non-overlapping windows', async () => {
    // 5 bars, 2 per page -> 3 requests.
    const series = [0, 1, 2, 3, 4].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const stub = new StubAdapter(series);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 4 * BAR_MS,
      barsPerPage: 2,
    });

    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.every((c) => c.timeframe === TF && c.symbol === SYMBOL)).toBe(true);
    const pageMs = 2 * BAR_MS;
    expect(stub.calls[0]).toMatchObject({ fromMs: BASE, toMs: BASE + pageMs - 1 });
    expect(stub.calls[1]).toMatchObject({ fromMs: BASE + pageMs, toMs: BASE + 2 * pageMs - 1 });
    expect(stub.calls[2]).toMatchObject({ fromMs: BASE + 2 * pageMs, toMs: BASE + 4 * BAR_MS });

    // All five bars, exactly once, in order.
    expect(result.candles.map((c) => c.timestampMs)).toEqual(series.map((c) => c.timestampMs));
    expect(result.requests).toBe(3);
  });

  it('honors the requested range (drops any trailing candle beyond --to)', async () => {
    // The exchange returns a candle beyond `toMs` (ignoreRange stub); it must
    // not be written.
    const stub = new StubAdapter([candle(BASE), candle(BASE + BAR_MS), candle(BASE + 2 * BAR_MS)], true);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + BAR_MS,
    });
    expect(result.candles.map((c) => c.timestampMs)).toEqual([BASE, BASE + BAR_MS]);
    expect(result.rawCount).toBe(3);
  });

  it('warns when the requested start is not covered', async () => {
    const stub = new StubAdapter([candle(BASE + 5 * BAR_MS)]);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 5 * BAR_MS,
    });
    expect(result.warnings.some((w) => /requested start/.test(w))).toBe(true);
  });

  it('reports interior gaps explicitly (and never repairs them)', async () => {
    // A missing bar between BASE and BASE + 2*BAR_MS.
    const stub = new StubAdapter([candle(BASE), candle(BASE + 2 * BAR_MS)]);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 2 * BAR_MS,
    });
    expect(result.candles).toHaveLength(2);
    expect(result.gapCount).toBe(1);
    expect(result.largestGapMs).toBe(2 * BAR_MS);
    expect(result.warnings.some((w) => /interior gap/.test(w))).toBe(true);
  });

  it('retries an intermittently-empty page instead of manufacturing a gap', async () => {
    // The exchange returns [] for the first page on call 1, then the real data.
    const series = [0, 1, 2, 3, 4].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    let calls = 0;
    const flaky = {
      async getCandles(
        symbol: string,
        timeframe: Timeframe,
        opts?: { fromMs?: number; toMs?: number; limit?: number },
      ): Promise<Candle[]> {
        calls += 1;
        if (calls === 1) return [];
        const from = opts?.fromMs ?? Number.NEGATIVE_INFINITY;
        const to = opts?.toMs ?? Number.POSITIVE_INFINITY;
        return series.filter((c) => c.timestampMs >= from && c.timestampMs <= to);
      },
    };
    const result = await acquireCandles(asAdapter(flaky as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 4 * BAR_MS,
      barsPerPage: 5,
    });
    expect(calls).toBe(2);
    expect(result.candles.map((c) => c.timestampMs)).toEqual(series.map((c) => c.timestampMs));
    expect(result.gapCount).toBe(0);
  });

  it('accepts a genuinely empty page after exhausting bounded attempts', async () => {
    // An always-empty adapter must still fail closed, after a bounded number of
    // attempts (never an unbounded retry loop).
    const stub = new StubAdapter([]);
    await expect(
      acquireCandles(asAdapter(stub), {
        symbol: SYMBOL,
        timeframe: TF,
        fromMs: BASE,
        toMs: BASE + BAR_MS,
        pageAttempts: 3,
      }),
    ).rejects.toThrow(/no candles returned/);
    expect(stub.calls).toHaveLength(3);
  });

  it('rejects a symbol/timeframe mismatch', async () => {
    const wrong = candle(BASE, '100', { symbol: 'ETH/CAD' });
    const stub = new StubAdapter([wrong]);
    await expect(
      acquireCandles(asAdapter(stub), { symbol: SYMBOL, timeframe: TF, fromMs: BASE, toMs: BASE + BAR_MS }),
    ).rejects.toThrow(/does not match requested/);
  });

  // ---- Truncated-tail page handling (real NDAX data-integrity bug) ----

  it('accepts a complete page whose head is covered', async () => {
    const series = [0, 1, 2].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const stub = new StubAdapter(series);
    const result = await acquireCandles(asAdapter(stub), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 2 * BAR_MS,
      barsPerPage: 3,
    });
    expect(stub.calls).toHaveLength(1);
    expect(result.candles.map((c) => c.timestampMs)).toEqual(series.map((c) => c.timestampMs));
  });

  it('retries an empty page instead of advancing (focused)', async () => {
    const series = [0, 1].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const adapter = new ScriptedAdapter([[], series]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + BAR_MS,
      barsPerPage: 2,
    });
    expect(adapter.calls).toHaveLength(2);
    expect(result.candles.map((c) => c.timestampMs)).toEqual(series.map((c) => c.timestampMs));
  });

  it('rejects a non-empty truncated-tail page (head omitted) and retries it', async () => {
    const full = [0, 1, 2, 3].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    // NDAX failure mode: only the tail of the requested page is returned, so the
    // first two bars (including the page head) are silently omitted.
    const truncatedTail = [candle(BASE + 2 * BAR_MS), candle(BASE + 3 * BAR_MS)];
    const adapter = new ScriptedAdapter([truncatedTail, full]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 3 * BAR_MS,
      barsPerPage: 4,
    });
    // The truncated page must NOT be accepted: the same page is retried and the
    // complete response is used, leaving no gap.
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]).toMatchObject({ fromMs: BASE, toMs: BASE + 3 * BAR_MS });
    expect(result.candles.map((c) => c.timestampMs)).toEqual(full.map((c) => c.timestampMs));
    expect(result.gapCount).toBe(0);
  });

  it('fails clearly when a page inside the series stays truncated on every attempt', async () => {
    const page0 = [0, 1, 2, 3].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    // Page 1 never returns its head: only its tail (BASE+6, BASE+7) is observed.
    const page1Truncated = [candle(BASE + 6 * BAR_MS), candle(BASE + 7 * BAR_MS)];
    const adapter = new ScriptedAdapter([page0, page1Truncated]);
    let error: Error | undefined;
    try {
      await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
        symbol: SYMBOL,
        timeframe: TF,
        fromMs: BASE,
        toMs: BASE + 7 * BAR_MS,
        barsPerPage: 4,
        pageAttempts: 3,
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/did not return a complete response/);
    expect(error!.message).toContain('Refusing to accept a truncated page');
    // The error identifies the requested page bounds.
    expect(error!.message).toContain(new Date(BASE + 4 * BAR_MS).toISOString());
    expect(error!.message).toContain(new Date(BASE + 7 * BAR_MS).toISOString());
    // 1 call for page 0 (complete) + 3 bounded attempts for page 1, then fail.
    expect(adapter.calls).toHaveLength(4);
  });

  it('accepts a complete page on a later retry and continues paginating normally', async () => {
    const full = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const page0 = full.slice(0, 4);
    const page0Truncated = full.slice(2, 4); // page 0 head (BASE, BASE+BAR) omitted
    const page1 = full.slice(4, 8);
    const adapter = new ScriptedAdapter([page0Truncated, page0, page1]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 7 * BAR_MS,
      barsPerPage: 4,
    });
    expect(result.candles.map((c) => c.timestampMs)).toEqual(full.map((c) => c.timestampMs));
    expect(result.gapCount).toBe(0);
    // Page 0 retried once, then page 1 fetched once.
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[0]).toMatchObject({ fromMs: BASE, toMs: BASE + 4 * BAR_MS - 1 });
    expect(adapter.calls[1]).toMatchObject({ fromMs: BASE, toMs: BASE + 4 * BAR_MS - 1 });
    expect(adapter.calls[2]).toMatchObject({ fromMs: BASE + 4 * BAR_MS, toMs: BASE + 7 * BAR_MS });
  });

  it('accepts a legitimately short final page (fewer bars than page size)', async () => {
    const series = [0, 1, 2].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const adapter = new ScriptedAdapter([series]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 2 * BAR_MS,
      barsPerPage: 500,
    });
    expect(adapter.calls).toHaveLength(1);
    expect(result.candles.map((c) => c.timestampMs)).toEqual(series.map((c) => c.timestampMs));
    expect(result.gapCount).toBe(0);
  });

  it('preserves retention-edge behavior: a late-starting first data page is accepted', async () => {
    // Page 0 (before available history) is always empty; page 0's retry and
    // page 1 return data that starts later than requested. This must NOT fail,
    // and the coverage warning must remain.
    const firstData = [candle(BASE + 3 * BAR_MS)];
    const page1Complete = [4, 5, 6, 7].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const adapter = new ScriptedAdapter([[], firstData, page1Complete]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 7 * BAR_MS,
      barsPerPage: 4,
      pageAttempts: 2,
    });
    expect(result.candles.map((c) => c.timestampMs)).toEqual([
      BASE + 3 * BAR_MS,
      BASE + 4 * BAR_MS,
      BASE + 5 * BAR_MS,
      BASE + 6 * BAR_MS,
      BASE + 7 * BAR_MS,
    ]);
    expect(result.warnings.some((w) => /requested start/.test(w))).toBe(true);
  });

  it('produces ascending, non-overlapping output across pages', async () => {
    const series = [0, 1, 2, 3, 4].map((i) => candle(BASE + i * BAR_MS, String(100 + i)));
    const adapter = new ScriptedAdapter([series.slice(0, 2), series.slice(2, 4), series.slice(4, 5)]);
    const result = await acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
      symbol: SYMBOL,
      timeframe: TF,
      fromMs: BASE,
      toMs: BASE + 4 * BAR_MS,
      barsPerPage: 2,
    });
    const ts = result.candles.map((c) => c.timestampMs);
    expect(ts).toEqual(series.map((c) => c.timestampMs));
    for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBe(BAR_MS);
    expect(new Set(ts).size).toBe(ts.length);
    // Contiguous, non-overlapping page windows.
    expect(adapter.calls[0]).toMatchObject({ fromMs: BASE, toMs: BASE + 2 * BAR_MS - 1 });
    expect(adapter.calls[1]).toMatchObject({ fromMs: BASE + 2 * BAR_MS, toMs: BASE + 4 * BAR_MS - 1 });
    expect(adapter.calls[2]).toMatchObject({ fromMs: BASE + 4 * BAR_MS, toMs: BASE + 4 * BAR_MS });
  });

  it('still fails on a duplicate timestamp across pages (never silently deduplicated)', async () => {
    const adapter = new ScriptedAdapter([
      [candle(BASE), candle(BASE + BAR_MS)],
      [candle(BASE + BAR_MS), candle(BASE + 2 * BAR_MS), candle(BASE + 3 * BAR_MS)],
    ]);
    await expect(
      acquireCandles(asAdapter(adapter as unknown as StubAdapter), {
        symbol: SYMBOL,
        timeframe: TF,
        fromMs: BASE,
        toMs: BASE + 3 * BAR_MS,
        barsPerPage: 2,
      }),
    ).rejects.toThrow(/duplicate candle timestamp/);
  });

  it('never calls any trading/account method', async () => {
    const stub = new StubAdapter([candle(BASE)]);
    // If acquisition touched placeOrder/cancelOrder/getBalances they would throw.
    await expect(
      acquireCandles(asAdapter(stub), { symbol: SYMBOL, timeframe: TF, fromMs: BASE, toMs: BASE + BAR_MS }),
    ).resolves.toBeDefined();
  });
});
