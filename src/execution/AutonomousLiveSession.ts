/**
 * AutonomousLiveSession — an explicit, bounded, process-local capability that
 * permits an ARMED autonomous LIVE engine to place LIMIT-IOC orders.
 *
 * This is the deliberate arming mechanism for unattended live trading. It is
 * NOT a generic "live enabled" flag that any caller can conjure: a session is
 * only "genuine" if its token was issued by THIS running process AND the scope
 * it presents byte-for-byte equals the issued scope. A hand-constructed object
 * (or a clone with a flipped side / widened caps) is rejected.
 *
 * Design parallels `ControlledLiveAuthorization`, with four deliberate
 * differences appropriate to a continuous, unattended loop:
 *   - BOTH sides are permitted (autonomous entries AND exits), not one side.
 *   - LIMIT + IOC only, so an order never rests on the book (the one-in-flight
 *     guard stays clean and no auto-cancel path is required).
 *   - A SESSION budget (max orders, max cumulative quote notional) in addition
 *     to per-order caps; the budget is consumed at the exchange mutation
 *     boundary so a session cannot exceed its envelope even across restarts of
 *     the decision loop.
 *   - An EXPIRY, after which the session is refused and the loop must re-arm.
 *
 * `NdaxAdapter.capabilities.supportsOrderPlacement` remains false. This session
 * is the explicit, audited exception, exactly like the controlled-test
 * authorization — but scoped to a deliberate autonomous session.
 */

import { randomUUID } from 'node:crypto';
import { Money } from '../money/Money.js';
import type { OrderSide, OrderTif, OrderType } from '../order.js';

/** The only permitted autonomous order shape (LIMIT + IOC). */
export interface AutonomousLiveScope {
  type: 'limit';
  tif: 'IOC';
  /** Sides this session may trade. */
  sides: readonly OrderSide[];
  /** Hard per-order max base quantity. */
  maxBaseQuantity: Money;
  /** Hard per-order max quote notional (quantity × limit price). */
  maxQuoteNotional: Money;
  /** Session ceiling on cumulative quote notional across all authorized orders. */
  maxSessionQuoteNotional: Money;
  /** Session ceiling on the number of authorized orders. */
  maxSessionOrders: number;
  /** Session expiry (ms epoch). */
  expiresAtMs: number;
}

export interface AutonomousLiveSession {
  readonly kind: 'autonomous-live-session';
  readonly scope: AutonomousLiveScope;
  /** Uniqueness token (audit/identity; NOT a secret). */
  readonly token: string;
}

/** Mutable per-session usage, tracked process-locally alongside the issued scope. */
interface SessionState {
  scope: AutonomousLiveScope;
  orders: number;
  quoteNotional: Money;
}

/**
 * Process-local issued-session registry (token -> exact scope + usage). Enters
 * ONLY via `createAutonomousLiveSession` in this process. Never exported,
 * serialized, or loaded from state. A session is therefore a process-local
 * capability: arming is per-process and does not survive a restart (the live
 * engine re-arms deliberately on each start).
 */
const sessions = new Map<string, SessionState>();

export type SessionAuthorizationResult = { ok: true } | { ok: false; reason: string };

function isPositiveMoney(v: unknown): v is Money {
  return v instanceof Money && v.isPositive();
}

function isValidScope(scope: unknown): scope is AutonomousLiveScope {
  if (typeof scope !== 'object' || scope === null) return false;
  const s = scope as Partial<AutonomousLiveScope>;
  return (
    s.type === 'limit' &&
    s.tif === 'IOC' &&
    Array.isArray(s.sides) &&
    s.sides.length > 0 &&
    s.sides.every((x) => x === 'BUY' || x === 'SELL') &&
    isPositiveMoney(s.maxBaseQuantity) &&
    isPositiveMoney(s.maxQuoteNotional) &&
    isPositiveMoney(s.maxSessionQuoteNotional) &&
    typeof s.maxSessionOrders === 'number' &&
    Number.isInteger(s.maxSessionOrders) &&
    s.maxSessionOrders > 0 &&
    typeof s.expiresAtMs === 'number' &&
    Number.isFinite(s.expiresAtMs) &&
    s.expiresAtMs > 0
  );
}

function sameScope(a: AutonomousLiveScope, b: AutonomousLiveScope): boolean {
  return (
    a.type === b.type &&
    a.tif === b.tif &&
    a.sides.length === b.sides.length &&
    a.sides.every((s, i) => s === b.sides[i]) &&
    a.maxBaseQuantity.equals(b.maxBaseQuantity) &&
    a.maxQuoteNotional.equals(b.maxQuoteNotional) &&
    a.maxSessionQuoteNotional.equals(b.maxSessionQuoteNotional) &&
    a.maxSessionOrders === b.maxSessionOrders &&
    a.expiresAtMs === b.expiresAtMs
  );
}

function freezeScope(scope: AutonomousLiveScope): AutonomousLiveScope {
  return {
    type: scope.type,
    tif: scope.tif,
    sides: [...scope.sides],
    maxBaseQuantity: scope.maxBaseQuantity,
    maxQuoteNotional: scope.maxQuoteNotional,
    maxSessionQuoteNotional: scope.maxSessionQuoteNotional,
    maxSessionOrders: scope.maxSessionOrders,
    expiresAtMs: scope.expiresAtMs,
  };
}

/**
 * Create an autonomous live session. Fails closed on any malformed scope. This
 * is the ONLY way to obtain a genuine `AutonomousLiveSession`.
 */
export function createAutonomousLiveSession(scope: AutonomousLiveScope): AutonomousLiveSession {
  if (!isValidScope(scope)) {
    throw new Error('invalid autonomous live session scope (LIMIT+IOC, allowed sides, positive caps/budget, future expiry required)');
  }
  const token = randomUUID();
  const issued = freezeScope(scope);
  sessions.set(token, { scope: issued, orders: 0, quoteNotional: Money.zero() });
  return { kind: 'autonomous-live-session', scope: issued, token };
}

/**
 * True if `value` is a GENUINE, UNEXPIRED session issued by THIS process. A
 * forged token, a clone with a tampered scope, or an expired session is
 * rejected.
 */
export function isAutonomousLiveSession(
  value: unknown,
  nowMs: number = Date.now(),
): value is AutonomousLiveSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; token?: unknown; scope?: unknown };
  if (v.kind !== 'autonomous-live-session') return false;
  if (typeof v.token !== 'string') return false;
  const issued = sessions.get(v.token);
  if (!issued) return false;
  if (!isValidScope(v.scope) || !sameScope(v.scope, issued.scope)) return false;
  if (nowMs >= issued.scope.expiresAtMs) return false;
  return true;
}

/** Explicitly revoke a session (e.g. on engine shutdown / kill switch). */
export function endAutonomousLiveSession(token: string): void {
  sessions.delete(token);
}

/** Read-only usage snapshot for audit/status (never mutates). */
export function autonomousSessionUsage(
  session: AutonomousLiveSession,
): { orders: number; quoteNotional: Money; remainingOrders: number; remainingQuoteNotional: Money } | null {
  const state = sessions.get(session.token);
  if (!state) return null;
  return {
    orders: state.orders,
    quoteNotional: state.quoteNotional,
    remainingOrders: Math.max(0, state.scope.maxSessionOrders - state.orders),
    remainingQuoteNotional: state.scope.maxSessionQuoteNotional.sub(state.quoteNotional),
  };
}

/** The subset of an order the autonomous boundary needs. */
export interface AutonomousOrderLike {
  side: string;
  type: OrderType | string;
  tif?: OrderTif | string | null;
  quantity: Money;
  price?: Money | null;
}

/**
 * Evaluate whether `order` is within `session`'s scope and budget, WITHOUT
 * consuming budget. Pure/read-only. Used by the engine for pre-submission
 * validation and by the adapter as the mutation-boundary check.
 */
export function evaluateAutonomousLiveOrder(
  order: AutonomousOrderLike,
  session: unknown,
  nowMs: number = Date.now(),
): SessionAuthorizationResult {
  if (!isAutonomousLiveSession(session, nowMs)) {
    return { ok: false, reason: 'not a genuine, unexpired autonomous live session' };
  }
  const state = sessions.get(session.token)!;
  const scope = state.scope;

  if (order.type !== 'limit' || scope.type !== 'limit') {
    return { ok: false, reason: 'autonomous live orders must be LIMIT' };
  }
  if (order.tif !== 'IOC' || scope.tif !== 'IOC') {
    return { ok: false, reason: 'autonomous live orders must be IOC (never rest on the book)' };
  }
  if (!scope.sides.includes(order.side as OrderSide)) {
    return { ok: false, reason: `side ${order.side} is not permitted by this session` };
  }
  if (!order.quantity.isPositive()) {
    return { ok: false, reason: 'quantity must be positive' };
  }
  if (order.quantity.compareTo(scope.maxBaseQuantity) > 0) {
    return { ok: false, reason: `quantity ${order.quantity} exceeds session max base quantity ${scope.maxBaseQuantity}` };
  }
  if (!order.price || !order.price.isPositive()) {
    return { ok: false, reason: 'a positive limit price is required' };
  }
  const notional = order.quantity.mul(order.price);
  if (notional.compareTo(scope.maxQuoteNotional) > 0) {
    return { ok: false, reason: `notional ${notional} exceeds session max quote notional ${scope.maxQuoteNotional}` };
  }
  if (state.orders + 1 > scope.maxSessionOrders) {
    return { ok: false, reason: `session order budget exhausted (${state.orders}/${scope.maxSessionOrders})` };
  }
  const nextNotional = state.quoteNotional.add(notional);
  if (nextNotional.compareTo(scope.maxSessionQuoteNotional) > 0) {
    return { ok: false, reason: `session quote-notional budget would be exceeded (${nextNotional}/${scope.maxSessionQuoteNotional})` };
  }
  return { ok: true };
}

/**
 * Mutation-boundary authorization: validate AND consume session budget on
 * success. Called by the exchange adapter exactly when it is about to submit.
 * Single-consumption is guaranteed by the process-local counter, so a session
 * can permit at most `maxSessionOrders` orders and `maxSessionQuoteNotional`
 * cumulative notional.
 */
export function authorizeAutonomousLiveOrder(
  order: AutonomousOrderLike,
  session: unknown,
  nowMs: number = Date.now(),
): SessionAuthorizationResult {
  const check = evaluateAutonomousLiveOrder(order, session, nowMs);
  if (!check.ok) return check;
  const state = sessions.get((session as AutonomousLiveSession).token)!;
  state.orders += 1;
  state.quoteNotional = state.quoteNotional.add(order.quantity.mul(order.price ?? Money.zero()));
  return { ok: true };
}
