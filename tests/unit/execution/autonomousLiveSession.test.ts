import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import {
  createAutonomousLiveSession,
  isAutonomousLiveSession,
  evaluateAutonomousLiveOrder,
  authorizeAutonomousLiveOrder,
  endAutonomousLiveSession,
  autonomousSessionUsage,
} from '../../../src/execution/AutonomousLiveSession.js';

const NOW = 1_000_000;

function scope(overrides: Partial<Parameters<typeof createAutonomousLiveSession>[0]> = {}) {
  return {
    type: 'limit' as const,
    tif: 'IOC' as const,
    sides: ['BUY', 'SELL'] as const,
    maxBaseQuantity: Money.fromString('1'),
    maxQuoteNotional: Money.fromString('1000'),
    maxSessionQuoteNotional: Money.fromString('5000'),
    maxSessionOrders: 3,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    side: 'BUY',
    type: 'limit',
    tif: 'IOC',
    quantity: Money.fromString('0.1'),
    price: Money.fromString('100'),
    ...overrides,
  };
}

describe('AutonomousLiveSession — bounded, process-local arming capability', () => {
  it('creates a genuine session and validates it before expiry', () => {
    const s = createAutonomousLiveSession(scope());
    expect(isAutonomousLiveSession(s, NOW)).toBe(true);
  });

  it('rejects a hand-constructed session (forged token)', () => {
    const forged = { kind: 'autonomous-live-session', token: 'not-issued', scope: scope() };
    expect(isAutonomousLiveSession(forged, NOW)).toBe(false);
    expect(evaluateAutonomousLiveOrder(order(), forged, NOW).ok).toBe(false);
  });

  it('rejects a clone whose scope was tampered (widened caps / flipped sides)', () => {
    const s = createAutonomousLiveSession(scope({ sides: ['SELL'] }));
    const tampered = { ...s, scope: { ...s.scope, sides: ['BUY'] as const } };
    expect(isAutonomousLiveSession(tampered, NOW)).toBe(false);
    // The genuine token cannot authorize a BUY when it was issued for SELL.
    expect(evaluateAutonomousLiveOrder(order({ side: 'BUY' }), s, NOW).ok).toBe(false);
  });

  it('rejects an expired session', () => {
    const s = createAutonomousLiveSession(scope({ expiresAtMs: NOW + 10 }));
    expect(isAutonomousLiveSession(s, NOW + 11)).toBe(false);
    expect(evaluateAutonomousLiveOrder(order(), s, NOW + 11).ok).toBe(false);
  });

  it('requires LIMIT + IOC, positive price, and caps', () => {
    const s = createAutonomousLiveSession(scope());
    expect(evaluateAutonomousLiveOrder(order({ type: 'market' }), s, NOW).ok).toBe(false);
    expect(evaluateAutonomousLiveOrder(order({ tif: 'GTC' }), s, NOW).ok).toBe(false);
    expect(evaluateAutonomousLiveOrder(order({ price: Money.zero() }), s, NOW).ok).toBe(false);
    expect(evaluateAutonomousLiveOrder(order({ quantity: Money.fromString('2') }), s, NOW).ok).toBe(false);
    expect(evaluateAutonomousLiveOrder(order(), s, NOW).ok).toBe(true);
  });

  it('enforces the session order budget and quote-notional budget, consuming on authorize', () => {
    const s = createAutonomousLiveSession(
      scope({ maxSessionOrders: 2, maxSessionQuoteNotional: Money.fromString('250'), maxQuoteNotional: Money.fromString('100') }),
    );
    // 2 orders at notional 10 each: within budget.
    expect(authorizeAutonomousLiveOrder(order({ quantity: Money.fromString('0.1'), price: Money.fromString('100') }), s, NOW).ok).toBe(true);
    expect(authorizeAutonomousLiveOrder(order({ quantity: Money.fromString('0.1'), price: Money.fromString('100') }), s, NOW).ok).toBe(true);
    // Third exceeds maxSessionOrders.
    const third = evaluateAutonomousLiveOrder(order(), s, NOW);
    expect(third.ok).toBe(false);
    const usage = autonomousSessionUsage(s)!;
    expect(usage.orders).toBe(2);
    expect(usage.remainingOrders).toBe(0);
  });

  it('exceeds neither budget silently: a large order is refused', () => {
    const s = createAutonomousLiveSession(scope({ maxSessionQuoteNotional: Money.fromString('50') }));
    const r = evaluateAutonomousLiveOrder(order({ quantity: Money.fromString('1'), price: Money.fromString('100') }), s, NOW);
    expect(r.ok).toBe(false);
  });

  it('endAutonomousLiveSession revokes a session', () => {
    const s = createAutonomousLiveSession(scope());
    endAutonomousLiveSession(s.token);
    expect(isAutonomousLiveSession(s, NOW)).toBe(false);
  });

  it('rejects malformed scopes at creation', () => {
    expect(() => createAutonomousLiveSession(scope({ sides: [] as never }))).toThrow();
    expect(() => createAutonomousLiveSession(scope({ maxBaseQuantity: Money.zero() }))).toThrow();
    expect(() => createAutonomousLiveSession(scope({ maxSessionOrders: 0 }))).toThrow();
  });
});
