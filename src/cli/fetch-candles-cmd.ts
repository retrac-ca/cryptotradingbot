/**
 * `bot fetch-candles` — acquire historical candles from the exchange into a
 * JSON file the existing backtest engine can consume.
 *
 * READ-ONLY: this command only calls the public market-data method
 * `ExchangeAdapter.getCandles`. It never places/cancels orders, never reads or
 * writes account/portfolio state, never touches `.state/`, and does NOT require
 * live-trading configuration (`REAL_FUNDS_AT_RISK` is irrelevant here). It
 * builds a public, unauthenticated adapter directly from the environment rather
 * than going through the trading config loader, so it can never be gated on or
 * enable trading.
 *
 * Usage:
 *   bot fetch-candles <SYMBOL> --timeframe <tf> --from <ISO|epoch-ms>
 *                     --to <ISO|epoch-ms> [--out <file>] [--page-bars <n>]
 *
 * The output is a JSON array of `{ symbol, timeframe, timestampMs, open, high,
 * low, close, baseVolume }` rows with exact decimal-string prices — the shape
 * `loadCandlesFromFile` already reads. It defaults to `data/candles/` (which is
 * git-ignored) so downloaded datasets are never committed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { createExchange } from '../exchanges/index.js';
import { TIMEFRAMES, type Timeframe } from '../types.js';
import { acquireCandles, candlesToRows, DEFAULT_BARS_PER_PAGE } from '../backtest/index.js';
import type { CommandHandler } from './context.js';

const SYMBOL_RE = /^[A-Za-z0-9]{2,12}\/[A-Za-z0-9]{2,12}$/;

export interface FetchCandlesArgs {
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  outFile: string;
  barsPerPage: number;
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** Parse an epoch-ms integer or an ISO-8601 date/time string into epoch ms. */
export function parseTimeArg(flag: string, value: string | undefined): number {
  if (value === undefined) fail(`missing value for ${flag}`);
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isFinite(ms) || ms <= 0) {
    fail(`${flag} must be an epoch-ms integer or an ISO-8601 date/time (got "${value}")`);
  }
  return ms;
}

/** Parse and validate `fetch-candles` arguments (pure; no I/O). */
export function parseFetchCandlesArgs(args: string[]): FetchCandlesArgs {
  let symbol = '';
  let timeframe: string | null = null;
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  let outFile: string | null = null;
  let barsPerPage = DEFAULT_BARS_PER_PAGE;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--timeframe') timeframe = args[++i] ?? null;
    else if (a === '--from') fromRaw = args[++i];
    else if (a === '--to') toRaw = args[++i];
    else if (a === '--out') outFile = args[++i] ?? null;
    else if (a === '--page-bars') {
      const v = Number(args[++i]);
      if (!Number.isInteger(v) || v <= 0) fail('--page-bars must be a positive integer');
      barsPerPage = v;
    } else if (!a.startsWith('--')) {
      if (symbol) fail(`unexpected extra argument "${a}"`);
      symbol = a.toUpperCase();
    } else {
      fail(`unknown flag "${a}"`);
    }
  }

  if (!symbol) {
    fail(
      'usage: bot fetch-candles <SYMBOL> --timeframe <tf> --from <ISO|epoch-ms> --to <ISO|epoch-ms> [--out <file>] [--page-bars <n>]',
    );
  }
  if (!SYMBOL_RE.test(symbol)) fail(`invalid symbol "${symbol}" (expected e.g. BTC/CAD)`);
  if (timeframe === null) fail('--timeframe is required (e.g. --timeframe 5m)');
  if (!(TIMEFRAMES as readonly string[]).includes(timeframe)) {
    fail(`unsupported timeframe "${timeframe}" (supported: ${TIMEFRAMES.join(', ')})`);
  }

  const fromMs = parseTimeArg('--from', fromRaw);
  const toMs = parseTimeArg('--to', toRaw);
  if (fromMs >= toMs) fail('--from must be strictly before --to');

  const tf = timeframe as Timeframe;
  const resolvedOut =
    outFile ?? join('data', 'candles', `${symbol.replace('/', '_')}_${tf}_${fromMs}_${toMs}.json`);

  return { symbol, timeframe: tf, fromMs, toMs, outFile: resolvedOut, barsPerPage };
}

/**
 * Build a public, unauthenticated adapter for read-only market data. Uses only
 * `EXCHANGE` / `NDAX_REST_BASE_URL` from the environment; authenticated reads
 * and order placement stay disabled (the adapter's defaults).
 */
export function buildPublicExchange(): ExchangeAdapter {
  const exchangeName = (process.env.EXCHANGE ?? 'ndax').trim().toLowerCase();
  const baseUrl = process.env.NDAX_REST_BASE_URL?.trim();
  return createExchange(exchangeName, {
    credentials: { apiKey: '', apiSecret: '', userId: '', userName: '' },
    config: {
      enableAuthenticatedReads: false,
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
}

export interface FetchCandlesDeps {
  adapter: ExchangeAdapter;
  /** Output sink (defaults to console.log). */
  log?: (line: string) => void;
}

/** Run the acquisition workflow. Exported for tests with an injected adapter. */
export async function runFetchCandles(args: string[], deps: FetchCandlesDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
  });

  let opts: FetchCandlesArgs;
  try {
    opts = parseFetchCandlesArgs(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Argument error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const fromIso = new Date(opts.fromMs).toISOString();
  const toIso = new Date(opts.toMs).toISOString();
  log(
    `Fetching ${opts.symbol} ${opts.timeframe} candles from ${fromIso} to ${toIso} ` +
      '(read-only public market data; no orders/account/state touched)',
  );

  let result;
  try {
    result = await acquireCandles(deps.adapter, {
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      barsPerPage: opts.barsPerPage,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Fetch failed: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const rows = candlesToRows(result.candles);
  try {
    mkdirSync(dirname(opts.outFile), { recursive: true });
    writeFileSync(opts.outFile, JSON.stringify(rows, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to write ' + opts.outFile + ': ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  log('  Symbol:            ' + opts.symbol);
  log('  Timeframe:         ' + opts.timeframe);
  log('  Requested range:   ' + fromIso + ' -> ' + toIso);
  log('  Requests:          ' + result.requests);
  log('  Candles retrieved: ' + result.candles.length + (result.rawCount !== result.candles.length ? ` (raw ${result.rawCount})` : ''));
  log('  First candle:      ' + (result.firstMs === null ? '(none)' : new Date(result.firstMs).toISOString()));
  log('  Last candle:       ' + (result.lastMs === null ? '(none)' : new Date(result.lastMs).toISOString()));
  log('  Ordering:          strictly ascending (duplicates rejected, never deduplicated)');
  log(
    '  Gaps:              ' +
      (result.gapCount === 0
        ? 'none (contiguous at the requested timeframe)'
        : `${result.gapCount} interior gap(s), largest ${result.largestGapMs}ms (real data; not repaired)`),
  );
  log('  Output file:       ' + opts.outFile);
  for (const w of result.warnings) log('  Warning:           ' + w);
  log('  NOTE: candles are real exchange data; any gap is real (nothing was synthesized).');

  return 0;
}

export const fetchCandlesCommand: CommandHandler = async (args): Promise<number> => {
  let adapter: ExchangeAdapter;
  try {
    adapter = buildPublicExchange();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to build exchange adapter: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }
  return runFetchCandles(args, { adapter });
};
