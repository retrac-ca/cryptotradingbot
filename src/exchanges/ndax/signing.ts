/**
 * NDAX API signing.
 *
 * ⚠️ VERIFY: The retail NDAX API does NOT document its signature algorithm in
 * the official apidoc. All third-party connectors (ndaxrs, Hummingbot, CCXT)
 * independently agree on:
 *
 *   signature = lowercase-hex( HMAC-SHA256( key = apiSecret,
 *                                           msg = nonce + userId + apiKey ) )
 *
 * where `+` is plain string concatenation with NO separators, and `nonce` is
 * epoch milliseconds. This must be verified against the live API before it is
 * trusted for real authentication. It is isolated here so it can be validated
 * and corrected in one place.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_RE = /^[0-9a-f]{64}$/;

/** Compute the NDAX `AuthenticateUser`/`Authenticate` signature. */
export function ndaxSignature(
  apiSecret: string,
  nonce: string,
  userId: string,
  apiKey: string,
): string {
  const msg = `${nonce}${userId}${apiKey}`;
  return createHmac('sha256', apiSecret).update(msg, 'utf8').digest('hex');
}

/** Current nonce = epoch milliseconds. */
export function ndaxNonce(): string {
  return String(Date.now());
}

/**
 * Constant-time check that a provided signature matches the expected one.
 * Prevents trivial hash-comparison timing attacks on auth.
 */
export function signaturesMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** True if `s` looks like a 64-char lowercase hex digest (defensive). */
export function isHexDigest(s: string): boolean {
  return HEX_RE.test(s);
}
