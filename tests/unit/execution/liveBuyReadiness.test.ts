/**
 * Gate 7.4 — first-live-BUY readiness gate.
 *
 * The gate is READ-ONLY: it inspects pre-assessed conditions and, fail-closed,
 * blocks live BUY unless EVERY requirement is verified true. `null` (unknown)
 * is treated as a blocker, never as "assume OK". NDAX currently lacks a
 * provably-unique lost-ack re-attachment mechanism and a mapped execution/fill
 * identity, so the NDAX facts make the gate return NOT_READY — live BUY stays
 * disabled.
 *
 * This file also proves (against a fake Portfolio, NO exchange submission) that
 * the reservation → idempotent fill → remaining-release lifecycle composes.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  evaluateLiveBuyReadiness,
  ndaxLiveBuyFacts,
} from '../../../src/execution/index.js';
import type { LiveBuyReadinessInput } from '../../../src/execution/index.js';
import type { Fill } from '../../../src/order.js';

function fullReady(): LiveBuyReadinessInput {
  return {
    operatorConfirmed: true,
    adapterSupportsOrderPlacement: true,
    adapterReadyVerified: true,
    snapshotFresh: true,
    portfolioValuationValid: true,
    reconciliationSafeToTrade: true,
    noUnresolvedUnknownOrders: true,
    noOrderOwnershipConflict: true,
    exchangeQuoteSufficient: true,
    managedCashSufficient: true,
    orderQuantityValid: true,
    referencePriceValid: true,
    feeCovered: true,
    durableOrderIdentity: true,
    reattachmentTrustworthy: true,
    executionIdentityTrustworthy: true,
  };
}

describe('Gate 7.4 — first-live-BUY readiness gate (fail closed)', () => {
  it('READY only when every condition is verified true', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    expect(report.verdict).toBe('READY');
    expect(report.liveBuyAllowed).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('any single missing condition blocks live BUY', () => {
    for (const key of Object.keys(fullReady()) as (keyof LiveBuyReadinessInput)[]) {
      const input = fullReady();
      input[key] = false;
      const report = evaluateLiveBuyReadiness(input);
      expect(report.verdict).toBe('NOT_READY');
      expect(report.liveBuyAllowed).toBe(false);
      expect(report.blockers).toContain(key);
      // Exactly the one blocker.
      expect(report.blockers).toHaveLength(1);
    }
  });

  it('an UNKNOWN (null) condition is treated as a blocker, never assumed OK', () => {
    const input = fullReady();
    input.executionIdentityTrustworthy = null;
    const report = evaluateLiveBuyReadiness(input);
    expect(report.verdict).toBe('NOT_READY');
    expect(report.blockers).toContain('executionIdentityTrustworthy');
    const cond = report.conditions.find((c) => c.id === 'executionIdentityTrustworthy')!;
    expect(cond.unknown).toBe(true);
    expect(cond.status).toBe('BLOCKED');
  });

  it('the NDAX readiness facts fail closed (no verified re-attachment / execution id)', () => {
    const input = fullReady();
    Object.assign(input, ndaxLiveBuyFacts());
    const report = evaluateLiveBuyReadiness(input);
    expect(report.verdict).toBe('NOT_READY');
    expect(report.liveBuyAllowed).toBe(false);
    // The NDAX blockers that Gate 7.3 documented.
    expect(report.blockers).toContain('reattachmentTrustworthy');
    expect(report.blockers).toContain('executionIdentityTrustworthy');
    expect(report.blockers).toContain('adapterReadyVerified');
    expect(report.blockers).toContain('noOrderOwnershipConflict');
  });

  it('missing snapshot freshness / stale / insufficient funds each block', () => {
    const stale = evaluateLiveBuyReadiness({ ...fullReady(), snapshotFresh: false });
    expect(stale.blockers).toContain('snapshotFresh');
    const noQuote = evaluateLiveBuyReadiness({ ...fullReady(), exchangeQuoteSufficient: false });
    expect(noQuote.blockers).toContain('exchangeQuoteSufficient');
    const unknown = evaluateLiveBuyReadiness({ ...fullReady(), reconciliationSafeToTrade: null });
    expect(unknown.blockers).toContain('reconciliationSafeToTrade');
  });
});

describe('Gate 7.4 — reservation -> idempotent fill -> release (no exchange submission)', () => {
  it('a single BUY fill consumes the reservation once and the remaining releases once', () => {
    let p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
    p = p.reserveOrder('o1', 'CAD', Money.fromString('5000'));
    const fill: Fill = {
      price: Money.fromString('40000'), quantity: Money.fromString('0.1'), fee: Money.fromString('1'),
      feeCurrency: 'quote', timestampMs: 1000, executionId: 'TRADE-1',
    };
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill);
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.10000000');
    expect(p.cash('CAD').toString()).toBe('5999.00000000'); // 10000 - (0.1*40000 + 1)
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('999.00000000'); // 5000 - 4001
    expect(p.reserved('CAD').toString()).toBe('999.00000000');
    expect(p.appliedCount()).toBe(1);

    // duplicate fill does not double-count.
    const dup = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', fill);
    expect(dup.position('BTC/CAD')!.quantity.toString()).toBe('0.10000000');
    expect(dup.appliedCount()).toBe(1);
    expect(dup.orderReservation('o1')!.remaining.toString()).toBe('999.00000000');

    // terminal release of the remaining reservation exactly once.
    const released = dup.releaseOrderReservation('o1');
    expect(released.orderReservation('o1')!.status).toBe('RELEASED');
    expect(released.orderReservation('o1')!.remaining.isZero()).toBe(true);
    expect(released.reserved('CAD').isZero()).toBe(true);
    const again = released.releaseOrderReservation('o1');
    expect(again.reserved('CAD').isZero()).toBe(true);
  });

  it('partial fills consume their own cost, and a duplicate partial does not double-count', () => {
    let p = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]));
    p = p.reserveOrder('o1', 'CAD', Money.fromString('60000'));
    const a: Fill = { price: Money.fromString('100000'), quantity: Money.fromString('0.3'), fee: Money.fromString('100'), feeCurrency: 'quote', timestampMs: 1000, executionId: 'A' };
    const b: Fill = { price: Money.fromString('100000'), quantity: Money.fromString('0.2'), fee: Money.fromString('50'), feeCurrency: 'quote', timestampMs: 2000, executionId: 'B' };
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', a); // cost 30100
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.30000000');
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('29900.00000000');
    p = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', b); // cost 20050
    expect(p.position('BTC/CAD')!.quantity.toString()).toBe('0.50000000');
    expect(p.orderReservation('o1')!.remaining.toString()).toBe('9850.00000000');
    expect(p.cash('CAD').toString()).toBe('49850.00000000'); // 100000 - 50150
    const dup = p.applyLiveFill('o1', 'BTC/CAD', 'BUY', b); // duplicate B
    expect(dup.position('BTC/CAD')!.quantity.toString()).toBe('0.50000000');
    expect(dup.orderReservation('o1')!.remaining.toString()).toBe('9850.00000000');
    expect(dup.appliedCount()).toBe(2);
  });
});
