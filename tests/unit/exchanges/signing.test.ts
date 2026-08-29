import { describe, expect, it } from 'vitest';
import { ndaxSignature, ndaxNonce, signaturesMatch, isHexDigest } from '../../../src/exchanges/ndax/signing.js';

describe('NDAX signing', () => {
  it('produces a 64-char lowercase hex HMAC-SHA256 digest', () => {
    const sig = ndaxSignature('secret', '123', '99', 'pubkey123');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the independently-documented concatenation formula', () => {
    // nonce|userId|apiKey with NO separators (per ndaxrs/Hummingbot/CCXT).
    const sig = ndaxSignature('s3cr3t', '1548715000000', '42', 'ABCDE');
    const crypto = require('node:crypto');
    const expected = crypto
      .createHmac('sha256', 's3cr3t')
      .update('154871500000042ABCDE')
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('varies with nonce, userId, and apiKey', () => {
    const base = ndaxSignature('s', '1', '2', '3');
    expect(ndaxSignature('s', '2', '2', '3')).not.toBe(base);
    expect(ndaxSignature('s', '1', '3', '3')).not.toBe(base);
    expect(ndaxSignature('s', '1', '2', '4')).not.toBe(base);
  });

  it('produces a plausible epoch-ms nonce', () => {
    const n = parseInt(ndaxNonce(), 10);
    expect(Number.isFinite(n)).toBe(true);
    expect(String(n).length).toBeGreaterThanOrEqual(12);
  });

  it('compares signatures in constant time', () => {
    const a = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(signaturesMatch(a, a)).toBe(true);
    expect(signaturesMatch(a, 'f' + a.slice(1))).toBe(false);
    expect(signaturesMatch(a, 'short')).toBe(false);
  });

  it('detects a hex digest shape', () => {
    expect(isHexDigest('a'.repeat(64))).toBe(true);
    expect(isHexDigest('z'.repeat(64))).toBe(false);
    expect(isHexDigest('a'.repeat(10))).toBe(false);
  });
});
