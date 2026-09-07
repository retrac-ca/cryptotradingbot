/**
 * Hybrid market-data freshness evaluation (Gate 4).
 *
 * "Fresh enough to risk money on" is now checked on TWO dimensions, not one:
 *
 *   1. QUOTE freshness — how old the *exchange-reported* quote time is. For NDAX
 *      this is the GetLevel1 `TimeStamp` ("the time this information was
 *      provided") and/or the newest GetL2Snapshot `ActionDateTime`.
 *   2. TRANSPORT freshness — how old the *local observation* is (when we
 *      actually fetched/stored the snapshot). A freshly-fetched snapshot can
 *      still be built on a stale quote, and a fresh quote can have been fetched
 *      long ago. Both must hold or the decision fails closed.
 *
 * Clock skew is handled explicitly: quote timestamps come from NDAX's server
 * clock, which is not our clock. A VERIFIED observation is that NDAX L1/L2
 * timestamps can sit ahead of local wall time (candle-end vs local now skew of
 * ~60s was observed but the direction is not firm). Rather than silently
 * tolerating any forward-dated quote, we accept a bounded, configurable skew
 * (`maxAcceptableFutureSkewMs`, default 2 minutes) and reject anything beyond
 * it as `QUOTE_AHEAD_OF_CLOCK`. This is NOT a widening of the stale threshold:
 * `maxQuoteAgeMs` (backed by `MARKET_DATA_MAX_AGE_MS`, default 60s) is left
 * untouched when the tolerances are configured.
 *
 * These helpers are pure and deterministic; the RiskManager and the live-test
 * command both use them so there is a single source of truth for what "fresh"
 * means. Any missing/malformed input fails closed.
 */

/** Configurable freshness limits. */
export interface FreshnessPolicy {
  /**
   * Maximum age of the *quote* (exchange-reported) timestamp before the data
   * is stale. Backed by MARKET_DATA_MAX_AGE_MS (default 60000).
   */
  maxQuoteAgeMs: number;
  /**
   * Maximum age of the *local observation* (fetch/transport) timestamp before
   * the data is stale. Backed by MARKET_DATA_TRANSPORT_MAX_AGE_MS (default 60000).
   */
  maxTransportAgeMs: number;
  /**
   * How far a quote timestamp may be AHEAD of the local clock before we treat
   * it as unreliable (`QUOTE_AHEAD_OF_CLOCK`). Backed by MAX_CLOCK_SKEW_MS
   * (default 120000). This is a future-dating guard, not a staleness widening.
   */
  maxAcceptableFutureSkewMs: number;
}

/** Stable, typed freshness failure reasons. */
export const QUOTE_FRESHNESS_REASON = [
  'QUOTE_MISSING',
  'QUOTE_MALFORMED',
  'QUOTE_STALE',
  'QUOTE_AHEAD_OF_CLOCK',
  'TRANSPORT_MISSING',
  'TRANSPORT_MALFORMED',
  'TRANSPORT_STALE',
] as const;
export type QuoteFreshnessReason = (typeof QUOTE_FRESHNESS_REASON)[number];

export type FreshnessCheck =
  | { fresh: true }
  | { fresh: false; reason: QuoteFreshnessReason; detail: string };

/** True if a value looks like a real epoch-ms timestamp (accepted as-is). */
export function isValidEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export interface FreshnessInput {
  /** Local wall clock "now" for this decision. */
  nowMs: number;
  /** Exchange-reported quote time (L1 TimeStamp / newest L2 ActionDateTime). */
  quoteTimestampMs: number | null | undefined;
  /** Local time the snapshot was observed/fetched. */
  observedAtMs: number | null | undefined;
  policy: FreshnessPolicy;
}

/**
 * Combine the two freshness dimensions into a single decision. Checks are
 * ordered so the most fundamental failure (missing/malformed quote) wins first,
 * then the quote age, then the clock-skew guard, then the transport dimension.
 * Any failure returns `fresh: false` and the caller decides how to classify it
 * (the RiskManager maps every failure to `STALE_MARKET_DATA`).
 */
export function evaluateFreshness(input: FreshnessInput): FreshnessCheck {
  const { nowMs, quoteTimestampMs, observedAtMs, policy } = input;
  const p = policy;
  const fail = (reason: QuoteFreshnessReason, detail: string): FreshnessCheck => ({
    fresh: false,
    reason,
    detail,
  });

  if (quoteTimestampMs === null || quoteTimestampMs === undefined) {
    return fail('QUOTE_MISSING', 'no exchange quote timestamp available');
  }
  if (!isValidEpochMs(quoteTimestampMs)) {
    return fail('QUOTE_MALFORMED', `invalid quote timestamp: ${String(quoteTimestampMs)}`);
  }
  if (nowMs - quoteTimestampMs > p.maxQuoteAgeMs) {
    return fail(
      'QUOTE_STALE',
      `quote age ${nowMs - quoteTimestampMs}ms exceeds maxQuoteAgeMs ${p.maxQuoteAgeMs}ms`,
    );
  }
  if (quoteTimestampMs - nowMs > p.maxAcceptableFutureSkewMs) {
    return fail(
      'QUOTE_AHEAD_OF_CLOCK',
      `quote timestamp is ${quoteTimestampMs - nowMs}ms ahead of the local clock (maxAcceptableFutureSkewMs ${p.maxAcceptableFutureSkewMs}ms)`,
    );
  }

  if (observedAtMs === null || observedAtMs === undefined) {
    return fail('TRANSPORT_MISSING', 'no local observation (fetch) timestamp available');
  }
  if (!isValidEpochMs(observedAtMs)) {
    return fail('TRANSPORT_MALFORMED', `invalid observation timestamp: ${String(observedAtMs)}`);
  }
  if (nowMs - observedAtMs > p.maxTransportAgeMs) {
    return fail(
      'TRANSPORT_STALE',
      `observation age ${nowMs - observedAtMs}ms exceeds maxTransportAgeMs ${p.maxTransportAgeMs}ms`,
    );
  }

  return { fresh: true };
}

/**
 * Pick the freshest usable quote timestamp across available snapshot sources.
 *
 * NDAX GetLevel1 `TimeStamp` and GetL2Snapshot `ActionDateTime` are both
 * exchange-reported quote times. When both are present the newer one is the
 * most current market view; invalid values are ignored; if nothing usable is
 * available, null (which `evaluateFreshness` turns into a fail-closed
 * `QUOTE_MISSING`).
 */
export function newestQuoteTimestampMs(
  ticker: { timestampMs?: number | null } | null | undefined,
  orderBook: { quoteTimestampMs?: number } | null | undefined,
): number | null {
  const candidates: number[] = [];
  if (ticker && isValidEpochMs(ticker.timestampMs)) candidates.push(ticker.timestampMs);
  if (orderBook && isValidEpochMs(orderBook.quoteTimestampMs)) candidates.push(orderBook.quoteTimestampMs);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}