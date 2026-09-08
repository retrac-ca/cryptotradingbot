/**
 * Controlled-LIVE authorization — an explicit, narrowly-scoped gate for the
 * FIRST controlled NDAX production-mutation test.
 *
 * This is NOT autonomous live trading and NOT a generic "live enabled" flag.
 * It is a single-purpose authorization object that:
 *   - is created ONLY by the controlled live-test path (`bot live-test sell`),
 *   - is restricted to SELL + LIMIT only,
 *   - carries the controlled-test exposure caps,
 *   - is required BOTH by the LiveOrderEngine (to permit the controlled path)
 *     AND by the exchange adapter (to permit the actual SendOrder mutation),
 *   - cannot be used for BUY, MARKET, autonomous, or general live trading.
 *
 * `NdaxAdapter.capabilities.supportsOrderPlacement` stays `false` (the adapter
 * does NOT generally support autonomous placement); this authorization is a
 * separate, explicit, per-path exception.
 *
 * ANTI-FORGERY (runtime): TypeScript types disappear at runtime, so a plain
 * object can never be trusted by shape alone. A `ControlledLiveAuthorization` is
 * therefore only "genuine" if its token was issued by THIS running process:
 * `createControlledLiveAuthorization` records the token in a module-private
 * registry, and `isControlledLiveAuthorization` requires that token to be
 * present there. A hand-constructed `{ kind: 'controlled-live-test', token: 'x' }`
 * (or any valid-looking UUID that was never issued) is rejected. The registry is
 * never exported, never persisted, and never loaded from state, so the
 * authorization is a process-local capability, not a forgeable value.
 *
 * SINGLE-USE: the authorization is intended for one controlled live invocation.
 * `isControlledLiveOrder` consumes the token when it authorizes an order at the
 * mutation boundary, so a token can permit at most one SendOrder. If that
 * attempt is transiently interrupted (e.g. the SendOrder POST times out), the
 * engine records the order as UNKNOWN and the operator recovers via
 * `bot reconcile` (which does not need the authorization) and then re-runs
 * `bot live-test sell`, which issues a fresh authorization. This is a safe
 * recovery path; the only effect of consumption is that the exact token cannot
 * be reused for a second independent order.
 */

import { randomUUID } from 'node:crypto';
import { Money } from '../money/Money.js';

/** The only permitted controlled-test order shape. */
export interface ControlledLiveScope {
  side: 'SELL';
  type: 'limit';
  /** Hard max base quantity (enforced again at the execution boundary). */
  maxBaseQuantity: Money;
  /** Hard max quote notional for a BUY-equivalent exposure (enforced again). */
  maxQuoteNotional: Money;
}

/** An explicit, narrowly-scoped controlled-test authorization. */
export interface ControlledLiveAuthorization {
  readonly kind: 'controlled-live-test';
  readonly scope: ControlledLiveScope;
  /** Uniqueness token (audit/identity; NOT a secret — it is never a credential). */
  readonly token: string;
}

/**
 * Process-local issued-token registry.
 *
 * A token enters this set ONLY when `createControlledLiveAuthorization` runs in
 * this process. The set is module-private and never exported, serialized, or
 * loaded from state. `isControlledLiveAuthorization` requires membership, which
 * is the runtime proof that the running process actually issued the
 * authorization. A token is removed when it authorizes an order at the mutation
 * boundary (`isControlledLiveOrder`), making the authorization single-use.
 */
const issuedTokens = new Set<string>();

/** True only for a genuine positive `Money` (fixed-point) value. */
function isPositiveMoney(v: unknown): v is Money {
  return v instanceof Money && v.isPositive();
}

/** True if `scope` is a complete, runtime-usable controlled scope (SELL + LIMIT + positive Money caps). */
function isValidScope(scope: unknown): scope is ControlledLiveScope {
  if (typeof scope !== 'object' || scope === null) return false;
  const s = scope as Partial<ControlledLiveScope>;
  return (
    s.side === 'SELL' &&
    s.type === 'limit' &&
    isPositiveMoney(s.maxBaseQuantity) &&
    isPositiveMoney(s.maxQuoteNotional)
  );
}

/**
 * Create a controlled-test authorization. Validates the strict scope and fails
 * closed on anything that is not SELL + LIMIT with positive caps. This is the
 * ONLY way to obtain a genuine `ControlledLiveAuthorization`; the returned
 * token is registered with the process-local registry so that it passes
 * `isControlledLiveAuthorization`.
 */
export function createControlledLiveAuthorization(scope: ControlledLiveScope): ControlledLiveAuthorization {
  if (scope.side !== 'SELL') {
    throw new Error('controlled live test is SELL-only');
  }
  if (scope.type !== 'limit') {
    throw new Error('controlled live test is LIMIT-only');
  }
  if (!isPositiveMoney(scope.maxBaseQuantity)) {
    throw new Error('controlled live test requires a positive max base quantity');
  }
  if (!isPositiveMoney(scope.maxQuoteNotional)) {
    throw new Error('controlled live test requires a positive max quote notional');
  }
  const token = randomUUID();
  issuedTokens.add(token);
  return { kind: 'controlled-live-test', scope, token };
}

/**
 * True if `value` is a GENUINE controlled-test authorization: correct
 * discriminant, a string token, a token that THIS process issued, and a complete
 * runtime-usable scope. A hand-constructed object (including one with a
 * valid-looking UUID that was never issued, or a clone whose token is not in the
 * registry) is rejected. A consumed (single-use) token is no longer in the
 * registry and is therefore rejected.
 */
export function isControlledLiveAuthorization(value: unknown): value is ControlledLiveAuthorization {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; token?: unknown; scope?: unknown };
  if (v.kind !== 'controlled-live-test') return false;
  if (typeof v.token !== 'string') return false;
  // The token must have been issued by THIS running process. Merely having the
  // right shape (or a UUID-looking string) is never sufficient.
  if (!issuedTokens.has(v.token)) return false;
  // The scope must be complete and usable so it can be enforced at the boundary.
  if (!isValidScope(v.scope)) return false;
  return true;
}

/** The subset of an order that the controlled authorization boundary needs. */
export interface ControlledOrderLike {
  side: string;
  type: string;
  quantity: Money;
  price?: Money | null;
}

/**
 * True if `order` is a controlled-test order (SELL + LIMIT) AND is authorized by
 * a genuine controlled-test authorization, AND stays within the authorization's
 * own scope caps (max base quantity, positive price, quote notional <= max quote
 * notional). This is the adapter-side check: a BUY or MARKET order is NEVER
 * authorized, and an oversized order is never authorized, so it cannot slip
 * through even with a borrowed/forged authorization object.
 *
 * The caps are enforced HERE independently of `LiveOrderEngine`'s
 * `cfg.maxLiveBaseQuantity` / `cfg.maxLiveQuoteNotional`, so the authorization
 * remains safe if a future caller passes an issued authorization with a
 * different (e.g. smaller) scope.
 *
 * Single-use: on success this consumes the token (removes it from the registry),
 * so the authorization can permit at most one order at the mutation boundary.
 */
export function isControlledLiveOrder(order: ControlledOrderLike, authorization: unknown): boolean {
  if (!isControlledLiveAuthorization(authorization)) return false;
  const auth = authorization;
  if (order.side !== 'SELL' || order.type !== 'limit') return false;
  if (auth.scope.side !== 'SELL' || auth.scope.type !== 'limit') return false;
  if (!order.quantity.isPositive()) return false;
  if (order.quantity.compareTo(auth.scope.maxBaseQuantity) > 0) return false;
  if (!order.price || !order.price.isPositive()) return false;
  // Fixed-point quote notional (quantity × price); no floating point.
  const notional = order.quantity.mul(order.price);
  if (notional.compareTo(auth.scope.maxQuoteNotional) > 0) return false;
  // Consume the token: a token authorizes at most one order at the mutation
  // boundary. Removal also makes `isControlledLiveAuthorization` reject it
  // thereafter, so a reused token can never reach SendOrder again.
  issuedTokens.delete(auth.token);
  return true;
}
