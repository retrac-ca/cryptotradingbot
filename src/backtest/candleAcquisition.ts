/**
 * Historical candle acquisition (Backtesting V1) — READ-ONLY.
 *
 * This module exists so a real historical dataset can be produced from the
 * existing exchange abstraction WITHOUT any trading/account path. It only ever
 * calls `ExchangeAdapter.getCandles` (public market data). It cannot place or
 * cancel orders, read balances, or touch durable trading state — and it never
 * needs live-trading configuration.
 *
 * NDAX `GetTickerHistory` is not guaranteed to return an arbitrarily large
 * range in one response (empirically it caps/truncates wide ranges, and its
 * per-timeframe history retention is finite). To avoid silently returning a
 * truncated series, the requested range is fetched in BOUNDED, non-overlapping
 * windows and merged:
 *
 *   - windows advance by `barsPerPage` bars;
 *   - each window's upper bound is one second before the next window's lower
 *     bound, so a candle on a boundary cannot be returned twice regardless of
 *     whether the exchange filters by candle START or END time;
 *   - a page INSIDE the series is accepted ONLY when it is non-empty AND its
 *     earliest candle covers the requested page head. An EMPTY page — or a
 *     known NDAX failure mode where a non-empty but TRUNCATED-TAIL page omits
 *     the window head — is retried within the same bounded attempt budget. If a
 *     page inside the series never yields a complete response, the acquisition
 *     FAILS (a known-truncated page is never silently accepted). The first
 *     data-bearing page is exempt, so a requested start that predates NDAX
 *     history (the retention edge) is still honored and reported via the
 *     existing coverage warnings rather than failing;
 *   - the merged series is sorted ascending and DUPLICATE timestamps are a hard
 *     error (never silently deduplicated);
 *   - the result is validated with the existing backtest candle validator.
 *
 * The requested [fromMs, toMs] bounds are absolute epoch-ms. The output honors
 * them exactly (candles outside the requested range are not written), and any
 * shortfall in coverage is reported explicitly rather than hidden.
 */

import type { Candle, Timeframe } from '../types.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { TIMEFRAME_MS } from '../marketdata/candles.js';
import { validateCandles } from './validation.js';

/**
 * Maximum bars requested per HTTP call. NDAX `GetTickerHistory` silently
 * truncates a wide range to roughly its most recent few thousand rows (and can
 * return 0 intermittently near its retention edge), so each request must stay
 * small enough that it cannot be truncated. 500 bars is comfortably below the
 * observed cap on every timeframe.
 */
export const DEFAULT_BARS_PER_PAGE = 500;

/**
 * Bounded retry count for a page that returns ZERO rows. Empirically NDAX
 * `GetTickerHistory` intermittently returns an empty array for a bounded window
 * that does contain data (observed at a high rate, especially near the
 * history-retention edge). Dropping such a page would silently fabricate a gap
 * in an otherwise contiguous series, so an empty page is retried up to this many
 * attempts before its emptiness is accepted. This is bounded and read-only; a
 * genuinely empty (out-of-retention) window simply costs a few extra requests.
 */
export const DEFAULT_PAGE_ATTEMPTS = 10;

export interface AcquireCandlesOptions {
  symbol: string;
  timeframe: Timeframe;
  fromMs: number;
  toMs: number;
  /** Bars per request (bounded pagination). Defaults to `DEFAULT_BARS_PER_PAGE`. */
  barsPerPage?: number;
  /**
   * Maximum attempts per page when the exchange returns zero rows. Defaults to
   * `DEFAULT_PAGE_ATTEMPTS`. Must be a positive integer.
   */
  pageAttempts?: number;
}

export interface AcquireCandlesResult {
  /** Chronologically sorted, de-duplicated, validated candles within [from,to]. */
  candles: Candle[];
  /** Number of `getCandles` requests made. */
  requests: number;
  /** Candles returned across all requests, before range filtering. */
  rawCount: number;
  requestedFromMs: number;
  requestedToMs: number;
  firstMs: number | null;
  lastMs: number | null;
  /** Interior gaps (adjacent bars farther apart than one interval), if any. */
  gapCount: number;
  largestGapMs: number;
  /** Explicit, human-readable coverage/limitation notes (never silent). */
  warnings: string[];
}

/**
 * Fetch and validate historical candles for `[fromMs, toMs]` using bounded,
 * non-overlapping windows. Throws (fail closed) on an empty result, a
 * non-ascending/duplicate series, malformed OHLC, or a symbol/timeframe
 * mismatch.
 */
export async function acquireCandles(
  adapter: ExchangeAdapter,
  opts: AcquireCandlesOptions,
): Promise<AcquireCandlesResult> {
  const { symbol, timeframe } = opts;
  const barsPerPage = opts.barsPerPage ?? DEFAULT_BARS_PER_PAGE;
  const pageAttempts = opts.pageAttempts ?? DEFAULT_PAGE_ATTEMPTS;
  if (!Number.isInteger(barsPerPage) || barsPerPage <= 0) {
    throw new Error('acquireCandles: barsPerPage must be a positive integer');
  }
  if (!Number.isInteger(pageAttempts) || pageAttempts <= 0) {
    throw new Error('acquireCandles: pageAttempts must be a positive integer');
  }
  if (!Number.isFinite(opts.fromMs) || !Number.isFinite(opts.toMs)) {
    throw new Error('acquireCandles: fromMs/toMs must be finite epoch-ms values');
  }
  if (opts.fromMs >= opts.toMs) {
    throw new Error('acquireCandles: fromMs must be strictly before toMs');
  }

  const barMs = TIMEFRAME_MS[timeframe];
  if (!barMs) throw new Error(`acquireCandles: unsupported timeframe "${String(timeframe)}"`);

  // Align to whole seconds so the 1-second inter-window gap cannot collapse
  // (NDAX request dates are second-resolution).
  const fromMs = Math.floor(opts.fromMs / 1000) * 1000;
  const toMs = opts.toMs;
  const pageMs = barMs * barsPerPage;

  const raw: Candle[] = [];
  let requests = 0;
  let cursor = fromMs;
  while (cursor <= toMs) {
    const pageTo = Math.min(cursor + pageMs - 1, toMs);
    // The earliest candle a COMPLETE page must contain. NDAX `GetTickerHistory`
    // treats `FromDate` as exclusive of the bar whose END equals it (a complete
    // response starts at `fromMs + one interval`), so one interval of tolerance
    // is allowed before the page is judged to have dropped its head.
    const expectedHeadMs = cursor + barMs;

    // Retry an empty OR incomplete page rather than accepting it and advancing
    // the cursor. A non-empty truncated-tail response (only the tail of the
    // window, head omitted) is a known NDAX failure that must NEVER be silently
    // accepted. Retries are bounded.
    let accepted: Candle[] = [];
    let complete = false;
    let sawNonEmpty = false;
    let bestNonEmpty: Candle[] = [];
    for (let attempt = 1; attempt <= pageAttempts; attempt++) {
      const page = await adapter.getCandles(symbol, timeframe, { fromMs: cursor, toMs: pageTo });
      requests += 1;
      if (pageCoversHead(page, expectedHeadMs)) {
        accepted = page;
        complete = true;
        break;
      }
      if (page.length > 0) {
        sawNonEmpty = true;
        if (isBetterPage(page, bestNonEmpty)) bestNonEmpty = page;
      }
    }

    if (!complete) {
      if (sawNonEmpty && raw.length > 0) {
        // A page INSIDE the series never produced a complete response. Fail the
        // acquisition rather than silently accepting a known-truncated page.
        throw new Error(
          `acquireCandles: page [${new Date(cursor).toISOString()}, ${new Date(pageTo).toISOString()}] ` +
            `did not return a complete response after ${pageAttempts} attempt(s); earliest candle observed ` +
            `was ${new Date(earliestTimestampMs(bestNonEmpty)).toISOString()} (expected coverage at or ` +
            `before ${new Date(expectedHeadMs).toISOString()}). Refusing to accept a truncated page.`,
        );
      }
      // Before any candle has been collected, a late-starting first page is the
      // retention edge (the requested start predates available history): accept
      // the earliest real response instead of failing, so the start is not
      // required to begin exactly at --from. When every attempt was empty this
      // leaves the page empty (a real hole/retention window), which the existing
      // coverage warnings surface.
      accepted = bestNonEmpty;
    }

    for (const c of accepted) raw.push(c);
    cursor = pageTo + 1;
  }

  const warnings: string[] = [];

  // Chronological ordering is required; sort a copy so the adapter's order can
  // never leak through.
  const sorted = [...raw].sort((a, b) => a.timestampMs - b.timestampMs);

  // Reject duplicate timestamps rather than silently deduplicating.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.timestampMs === sorted[i - 1]!.timestampMs) {
      throw new Error(
        `acquireCandles: duplicate candle timestamp ${sorted[i]!.timestampMs} for ${symbol} ${timeframe}; ` +
          'refusing to write an ambiguous dataset',
      );
    }
  }

  // Honor the requested range exactly (drop any trailing candle the exchange
  // returned beyond `toMs`). This is not a "gap repair" — it is the requested
  // bound being respected.
  const candles = sorted.filter((c) => c.timestampMs >= fromMs && c.timestampMs <= toMs);

  // Symbol/timeframe consistency: never mix markets or timeframes.
  for (const c of candles) {
    if (c.symbol !== symbol) {
      throw new Error(`acquireCandles: candle symbol "${c.symbol}" does not match requested "${symbol}"`);
    }
    if (c.timeframe !== timeframe) {
      throw new Error(`acquireCandles: candle timeframe "${c.timeframe}" does not match requested "${timeframe}"`);
    }
  }

  if (candles.length === 0) {
    throw new Error(
      `acquireCandles: no candles returned for ${symbol} ${timeframe} in ` +
        `[${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`,
    );
  }

  const cv = validateCandles(candles);
  if (!cv.ok) throw new Error(`acquireCandles: invalid candle data: ${cv.reason}`);
  for (const w of cv.warnings) warnings.push(w);

  const firstMs = candles[0]!.timestampMs;
  const lastMs = candles[candles.length - 1]!.timestampMs;

  if (firstMs > fromMs + barMs) {
    warnings.push(
      `requested start ${new Date(fromMs).toISOString()} is not covered: earliest candle is ` +
        `${new Date(firstMs).toISOString()} (NDAX history retention/limits may omit older data)`,
    );
  }
  if (lastMs < toMs - barMs) {
    warnings.push(
      `requested end ${new Date(toMs).toISOString()} is not covered: latest candle is ` +
        `${new Date(lastMs).toISOString()}`,
    );
  }

  // Interior gaps: adjacent bars farther apart than one interval. These are
  // REAL (a quiet market, an exchange outage, or a retention hole) and are
  // reported explicitly — never repaired or interpolated.
  let gapCount = 0;
  let largestGapMs = 0;
  const gapSamples: string[] = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.timestampMs - candles[i - 1]!.timestampMs;
    if (delta > barMs) {
      gapCount += 1;
      if (delta > largestGapMs) largestGapMs = delta;
      if (gapSamples.length < 5) {
        const missing = Math.round(delta / barMs) - 1;
        gapSamples.push(
          `${new Date(candles[i - 1]!.timestampMs).toISOString()} -> ${new Date(candles[i]!.timestampMs).toISOString()} (${missing} missing bar(s))`,
        );
      }
    }
  }
  if (gapCount > 0) {
    warnings.push(
      `${gapCount} interior gap(s) in the series (largest ${largestGapMs}ms); ` +
        `the data is not contiguous. Samples: ${gapSamples.join('; ')}`,
    );
  }

  return {
    candles,
    requests,
    rawCount: raw.length,
    requestedFromMs: fromMs,
    requestedToMs: toMs,
    firstMs,
    lastMs,
    gapCount,
    largestGapMs,
    warnings,
  };
}

/** JSON-safe candle row consumable by `loadCandlesFromFile` / `runBacktest`. */
export interface CandleRowJson {
  symbol: string;
  timeframe: string;
  timestampMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string;
}

/**
 * Serialize candles to the repository's backtest JSON row shape. `Money` values
 * are written as exact decimal strings (no floating-point transformation), so
 * the backtest reconstructs the exact fixed-point values.
 */
export function candlesToRows(candles: Candle[]): CandleRowJson[] {
  return candles.map((c) => ({
    symbol: c.symbol,
    timeframe: c.timeframe,
    timestampMs: c.timestampMs,
    open: c.open.toString(),
    high: c.high.toString(),
    low: c.low.toString(),
    close: c.close.toString(),
    baseVolume: c.baseVolume.toString(),
  }));
}

/** Earliest timestamp in a page response, or `Infinity` for an empty page. */
function earliestTimestampMs(page: Candle[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const c of page) {
    if (c.timestampMs < earliest) earliest = c.timestampMs;
  }
  return earliest;
}

/**
 * True when a page response actually covers the start of its requested window.
 *
 * `expectedHeadMs` is the latest timestamp the FIRST returned candle may have
 * without implying the page head was omitted (allowing one interval for NDAX's
 * exclusive `FromDate` semantics). An empty page never covers its head.
 */
function pageCoversHead(page: Candle[], expectedHeadMs: number): boolean {
  if (page.length === 0) return false;
  return earliestTimestampMs(page) <= expectedHeadMs;
}

/**
 * Rank two non-empty page responses, preferring the one that starts earliest
 * (it covers more of the head), then the longest. Used ONLY to choose the
 * retention-edge first data page when the requested start predates available
 * history; a page inside the series never falls back to a partial response.
 */
function isBetterPage(candidate: Candle[], current: Candle[]): boolean {
  if (candidate.length === 0) return false;
  if (current.length === 0) return true;
  const candidateEarliest = earliestTimestampMs(candidate);
  const currentEarliest = earliestTimestampMs(current);
  if (candidateEarliest !== currentEarliest) return candidateEarliest < currentEarliest;
  return candidate.length > current.length;
}

