import { describe, expect, it } from 'vitest';
import {
  evaluateFreshness,
  isValidEpochMs,
  newestQuoteTimestampMs,
} from '../../../src/marketdata/freshness.js';

const NOW = 1_000_000_000;
const POLICY = {
  maxQuoteAgeMs: 60_000,
  maxTransportAgeMs: 60_000,
  maxAcceptableFutureSkewMs: 120_000,
};

function check(over: Partial<Parameters<typeof evaluateFreshness>[0]> = {}) {
  return evaluateFreshness({
    nowMs: NOW,
    quoteTimestampMs: NOW,
    observedAtMs: NOW,
    policy: POLICY,
    ...over,
  });
}

describe('evaluateFreshness', () => {
  it('accepts a fresh quote and fresh transport', () => {
    expect(check().fresh).toBe(true);
  });

  it('accepts a quote freshly observed even if it is slightly ahead of local time within skew', () => {
    // 30s ahead is within the 120s skew tolerance -> fresh.
    expect(check({ quoteTimestampMs: NOW + 30_000 }).fresh).toBe(true);
  });

  it('rejects a stale quote (age > maxQuoteAgeMs)', () => {
    const r = check({ quoteTimestampMs: NOW - 61_000 });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_STALE');
  });

  it('rejects a fresh quote whose transport is stale', () => {
    const r = check({ observedAtMs: NOW - 61_000 });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('TRANSPORT_STALE');
  });

  it('rejects a stale quote even when the transport is fresh (hybrid, fail closed)', () => {
    const r = check({
      quoteTimestampMs: NOW - 61_000,
      observedAtMs: NOW - 1_000,
    });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_STALE');
  });

  it('rejects a missing quote', () => {
    const r = check({ quoteTimestampMs: null });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_MISSING');
  });

  it('rejects a malformed quote (negative / zero / NaN)', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const r = check({ quoteTimestampMs: bad });
      expect(r.fresh).toBe(false);
      if (!r.fresh) expect(r.reason).toBe('QUOTE_MALFORMED');
    }
  });

  it('rejects a quote timestamp ahead of the clock beyond the skew guard', () => {
    const r = check({ quoteTimestampMs: NOW + 120_001 });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_AHEAD_OF_CLOCK');
  });

  it('accepts a quote exactly at the max age (boundary is inclusive of the threshold)', () => {
    // 60_000ms age == maxQuoteAgeMs => NOT > threshold => fresh.
    expect(check({ quoteTimestampMs: NOW - 60_000 }).fresh).toBe(true);
  });

  it('rejects a quote one millisecond over the max age (just-over-threshold)', () => {
    const r = check({ quoteTimestampMs: NOW - 60_001 });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_STALE');
  });

  it('accepts a quote exactly at the future-skew boundary', () => {
    // 120_000ms ahead == maxAcceptableFutureSkewMs => NOT > threshold => fresh.
    expect(check({ quoteTimestampMs: NOW + 120_000 }).fresh).toBe(true);
  });

  it('treats an infinite quote timestamp as malformed (fail closed)', () => {
    const r = check({ quoteTimestampMs: Number.POSITIVE_INFINITY });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('QUOTE_MALFORMED');
  });

  it('treats an infinite transport timestamp as malformed (fail closed)', () => {
    const r = check({ observedAtMs: Number.NEGATIVE_INFINITY });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('TRANSPORT_MALFORMED');
  });

  it('rejects a missing transport timestamp (fail closed)', () => {
    const r = check({ observedAtMs: null });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('TRANSPORT_MISSING');
  });

  it('rejects a malformed transport timestamp', () => {
    const r = check({ observedAtMs: -1 });
    expect(r.fresh).toBe(false);
    if (!r.fresh) expect(r.reason).toBe('TRANSPORT_MALFORMED');
  });
});

describe('isValidEpochMs', () => {
  it('accepts positive finite epoch millis', () => {
    expect(isValidEpochMs(1_700_000_000_000)).toBe(true);
  });
  it('rejects non-positive / non-finite / non-number', () => {
    expect(isValidEpochMs(0)).toBe(false);
    expect(isValidEpochMs(-1)).toBe(false);
    expect(isValidEpochMs(Number.NaN)).toBe(false);
    expect(isValidEpochMs(undefined)).toBe(false);
    expect(isValidEpochMs('123')).toBe(false);
  });
});

describe('newestQuoteTimestampMs', () => {
  it('picks the newer of ticker and book quote times', () => {
    expect(
      newestQuoteTimestampMs(
        { timestampMs: 100 },
        { quoteTimestampMs: 200 },
      ),
    ).toBe(200);
    expect(
      newestQuoteTimestampMs(
        { timestampMs: 300 },
        { quoteTimestampMs: 200 },
      ),
    ).toBe(300);
  });

  it('falls back to whichever source is available', () => {
    expect(newestQuoteTimestampMs({ timestampMs: 100 }, null)).toBe(100);
    expect(newestQuoteTimestampMs(null, { quoteTimestampMs: 200 })).toBe(200);
    expect(newestQuoteTimestampMs({ timestampMs: 100 }, { quoteTimestampMs: undefined })).toBe(100);
  });

  it('ignores invalid values and returns null when nothing usable', () => {
    expect(newestQuoteTimestampMs({ timestampMs: 0 }, { quoteTimestampMs: -1 })).toBeNull();
    expect(newestQuoteTimestampMs(null, null)).toBeNull();
    expect(newestQuoteTimestampMs(undefined, undefined)).toBeNull();
  });
});
