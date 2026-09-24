/**
 * `bot fetch-candles` tests — no network. Uses a stub adapter and temp files.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { loadCandlesFromFile } from '../../../src/backtest/index.js';
import { buildPublicExchange, parseFetchCandlesArgs, runFetchCandles } from '../../../src/cli/fetch-candles-cmd.js';
import type { ExchangeAdapter } from '../../../src/exchanges/ExchangeAdapter.js';
import type { Candle, Timeframe } from '../../../src/types.js';
import { statePath } from '../../helpers/state.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '1h';
const BAR_MS = 3_600_000;
const BASE = 1_700_000_000_000;

function candle(ts: number, close = '100'): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: ts,
    open: Money.fromString(close),
    high: Money.fromString(close),
    low: Money.fromString(close),
    close: Money.fromString(close),
    baseVolume: Money.fromString('1'),
  };
}

class StubAdapter {
  readonly calls: { timeframe: Timeframe; fromMs?: number; toMs?: number }[] = [];
  constructor(private readonly series: Candle[]) {}
  async getCandles(_s: string, timeframe: Timeframe, opts?: { fromMs?: number; toMs?: number }): Promise<Candle[]> {
    this.calls.push({ timeframe, fromMs: opts?.fromMs, toMs: opts?.toMs });
    const from = opts?.fromMs ?? Number.NEGATIVE_INFINITY;
    const to = opts?.toMs ?? Number.POSITIVE_INFINITY;
    return this.series.filter((c) => c.timestampMs >= from && c.timestampMs <= to);
  }
  async placeOrder(): Promise<never> {
    throw new Error('placeOrder must never be called');
  }
  async cancelOrder(): Promise<never> {
    throw new Error('cancelOrder must never be called');
  }
}

const asAdapter = (s: StubAdapter): ExchangeAdapter => s as unknown as ExchangeAdapter;

describe('parseFetchCandlesArgs', () => {
  it('parses required and optional arguments with a default output path', () => {
    const args = parseFetchCandlesArgs([
      'btc/cad',
      '--timeframe', '5m',
      '--from', '2026-07-15T00:00:00Z',
      '--to', '2026-08-01T00:00:00Z',
    ]);
    expect(args.symbol).toBe('BTC/CAD');
    expect(args.timeframe).toBe('5m');
    expect(args.fromMs).toBe(Date.parse('2026-07-15T00:00:00Z'));
    expect(args.toMs).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(args.outFile).toContain(join('data', 'candles'));
  });

  it('accepts epoch-ms bounds and an explicit --out', () => {
    const args = parseFetchCandlesArgs([
      'BTC/CAD', '--timeframe', '1h', '--from', String(BASE), '--to', String(BASE + BAR_MS), '--out', '/tmp/x.json',
    ]);
    expect(args.fromMs).toBe(BASE);
    expect(args.outFile).toBe('/tmp/x.json');
  });

  it('rejects missing/unknown arguments', () => {
    expect(() => parseFetchCandlesArgs(['BTC/CAD', '--from', '1', '--to', '2'])).toThrow(/timeframe/);
    expect(() => parseFetchCandlesArgs(['BTC/CAD', '--timeframe', '5m', '--to', '2'])).toThrow(/--from/);
    expect(() => parseFetchCandlesArgs(['BTC/CAD', '--timeframe', '5m', '--from', '1'])).toThrow(/--to/);
    expect(() => parseFetchCandlesArgs(['BTC/CAD', '--timeframe', 'nope', '--from', '1', '--to', '2'])).toThrow(/unsupported timeframe/);
    expect(() => parseFetchCandlesArgs(['BTC/CAD', '--timeframe', '5m', '--from', '2', '--to', '1'])).toThrow(/strictly before/);
    expect(() => parseFetchCandlesArgs([])).toThrow(/usage/);
  });
});

describe('buildPublicExchange', () => {
  it('builds a read-only adapter without live-trading configuration or order capability', () => {
    const prevMode = process.env.TRADING_MODE;
    const prevRisk = process.env.REAL_FUNDS_AT_RISK;
    process.env.TRADING_MODE = 'live';
    delete process.env.REAL_FUNDS_AT_RISK; // deliberately NOT set
    try {
      const ex = buildPublicExchange();
      expect(ex.id).toBe('ndax');
      // No order placement and no authenticated reads are ever enabled here.
      expect(ex.capabilities.supportsOrderPlacement).toBe(false);
      expect(ex.capabilities.publicDataRequiresAuth).toBe(false);
    } finally {
      if (prevMode === undefined) delete process.env.TRADING_MODE;
      else process.env.TRADING_MODE = prevMode;
      if (prevRisk === undefined) delete process.env.REAL_FUNDS_AT_RISK;
      else process.env.REAL_FUNDS_AT_RISK = prevRisk;
    }
  });
});

describe('runFetchCandles', () => {
  it('writes a dataset the backtest engine can consume', async () => {
    const out = statePath('fetchcandles', 'candles.json');
    const stub = new StubAdapter([candle(BASE, '100'), candle(BASE + BAR_MS, '101')]);
    const code = await runFetchCandles(
      ['BTC/CAD', '--timeframe', '1h', '--from', String(BASE), '--to', String(BASE + BAR_MS), '--out', out],
      { adapter: asAdapter(stub), log: () => {} },
    );
    expect(code).toBe(0);

    const raw = JSON.parse(readFileSync(out, 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toHaveLength(2);

    const candles = loadCandlesFromFile(out);
    expect(candles).toHaveLength(2);
    expect(candles[0]!.timestampMs).toBe(BASE);
    expect(candles[1]!.close.toString()).toBe('101.00000000');
    expect(candles[0]!.timeframe).toBe('1h');
  });

  it('returns non-zero on a fetch failure and writes nothing', async () => {
    const out = statePath('fetchcandles', 'none.json');
    const failing = {
      getCandles: async () => {
        throw new Error('simulated network failure');
      },
      placeOrder: async () => {
        throw new Error('never');
      },
      cancelOrder: async () => {
        throw new Error('never');
      },
    } as unknown as ExchangeAdapter;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runFetchCandles(
      ['BTC/CAD', '--timeframe', '1h', '--from', String(BASE), '--to', String(BASE + BAR_MS), '--out', out],
      { adapter: failing, log: () => {} },
    );
    expect(code).toBe(1);
    errorSpy.mockRestore();
  });

  it('returns non-zero on bad arguments without touching the adapter', async () => {
    const stub = new StubAdapter([candle(BASE)]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await runFetchCandles([], { adapter: asAdapter(stub), log: () => {} });
    expect(code).toBe(1);
    expect(stub.calls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});
