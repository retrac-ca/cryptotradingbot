/**
 * Controlled-LIVE BUY readiness model (redesign).
 *
 * The model is READ-ONLY and fail-closed for BLOCKING conditions, but it no
 * longer blocks on facts NDAX cannot prove. This suite proves:
 *   - controlled BUY can be READY with `supportsOrderPlacement=false`;
 *   - every BLOCKING condition (structural guarantee + read-only) blocks when
 *     false/unknown;
 *   - structural conditions are represented as `basis: STRUCTURAL_GUARANTEE`
 *     (construction/enforcement), distinct from read-only runtime observations;
 *   - reservation safety is transactional, so no vacuous "no conflicting active
 *     reservation" readiness observation is reported;
 *   - the first-controlled-real-BUY evidence NEVER blocks (it is pending);
 *   - the fundamentally-unprovable properties NEVER block (they are compensated);
 *   - the compensating controls are enumerated as ACTIVE;
 *   - there is no `operatorConfirmed` readiness field.
 *
 * It also keeps the pure reservation -> idempotent fill -> release lifecycle
 * proof (no exchange submission).
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  evaluateLiveBuyReadiness,
  structuralPlacementGuarantees,
  FUNDAMENTALLY_UNPROVABLE_PROPERTIES,
  SAFETY_COMPENSATIONS,
} from '../../../src/execution/index.js';
import type { LiveBuyReadinessInput } from '../../../src/execution/index.js';
import type { Fill } from '../../../src/order.js';

function fullReady(): LiveBuyReadinessInput {
  return {
    structuralAuthorizationCapability: true,
    structuralSideScopedToBuy: true,
    structuralLimitOnly: true,
    structuralSingleUse: true,
    structuralCapsPositive: true,
    structuralGeneralPlacementDisabled: true,
    structuralAdapterHonorsAuthorization: true,
    tradingModeIsLive: true,
    realFundsAtRisk: true,
    killSwitchInactive: true,
    authenticatedReadsEnabled: true,
    authenticatedReadVerified: true,
    snapshotFresh: true,
    portfolioValuationValid: true,
    reconciliationGateAllowed: true,
    noUnresolvedLiveOrder: true,
    currentExchangeOrderConflictClear: true,
    riskApproved: true,
    orderQuantityValid: true,
    referencePriceValid: true,
    exchangeQuoteSufficient: true,
    managedCashSufficient: true,
    feeCovered: true,
  };
}

const BLOCKING_KEYS = Object.keys(fullReady()) as (keyof LiveBuyReadinessInput)[];

describe('liveBuyReadiness — blocking conditions (fail closed)', () => {
  it('READY only when every blocking condition is verified true', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    expect(report.verdict).toBe('READY');
    expect(report.liveBuyAllowed).toBe(true);
    expect(report.blockers).toHaveLength(0);
  });

  it('any single missing blocking condition blocks live BUY', () => {
    for (const key of BLOCKING_KEYS) {
      const input = fullReady();
      input[key] = false;
      const report = evaluateLiveBuyReadiness(input);
      expect(report.verdict, `expected ${key} to block`).toBe('NOT_READY');
      expect(report.liveBuyAllowed).toBe(false);
      expect(report.blockers).toContain(key);
      expect(report.blockers).toHaveLength(1);
    }
  });

  it('an UNKNOWN (null) blocking condition is a blocker, never assumed OK', () => {
    for (const key of BLOCKING_KEYS) {
      const input = fullReady();
      input[key] = null;
      const report = evaluateLiveBuyReadiness(input);
      expect(report.verdict).toBe('NOT_READY');
      expect(report.blockers).toContain(key);
      const cond = report.conditions.find((c) => c.id === key)!;
      expect(cond.unknown).toBe(true);
      expect(cond.status).toBe('BLOCKED');
      expect(cond.blocking).toBe(true);
    }
  });
});

describe('liveBuyReadiness — controlled placement without general placement', () => {
  it('a controlled BUY is eligible with supportsOrderPlacement=false', () => {
    const guarantees = structuralPlacementGuarantees(
      { id: 'ndax', capabilities: { supportsOrderPlacement: false } },
      { liveMaxBaseQuantity: 0.01, liveMaxQuoteNotional: 100 },
    );
    expect(guarantees.structuralGeneralPlacementDisabled).toBe(true);
    expect(guarantees.structuralAdapterHonorsAuthorization).toBe(true);
    expect(guarantees.structuralAuthorizationCapability).toBe(true);

    const report = evaluateLiveBuyReadiness({ ...fullReady(), ...guarantees });
    expect(report.liveBuyAllowed).toBe(true);
  });

  it('supportsOrderPlacement=true (general placement advertised) blocks the controlled path', () => {
    const guarantees = structuralPlacementGuarantees(
      { id: 'some-exchange', capabilities: { supportsOrderPlacement: true } },
      { liveMaxBaseQuantity: 0.01, liveMaxQuoteNotional: 100 },
    );
    expect(guarantees.structuralGeneralPlacementDisabled).toBe(false);
    const report = evaluateLiveBuyReadiness({ ...fullReady(), ...guarantees });
    expect(report.verdict).toBe('NOT_READY');
    expect(report.blockers).toEqual(['structuralGeneralPlacementDisabled']);
  });

  it('invalid controlled-authorization caps block', () => {
    const guarantees = structuralPlacementGuarantees(
      { id: 'ndax', capabilities: { supportsOrderPlacement: false } },
      { liveMaxBaseQuantity: 0, liveMaxQuoteNotional: 100 },
    );
    expect(guarantees.structuralCapsPositive).toBe(false);
    const report = evaluateLiveBuyReadiness({ ...fullReady(), ...guarantees });
    expect(report.blockers).toContain('structuralCapsPositive');
  });

  it('structural placement facts are labelled STRUCTURAL_GUARANTEE, not runtime observations', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const structural = report.conditions.filter((c) => c.category === 'STRUCTURAL_GUARANTEE');
    expect(structural.length).toBeGreaterThan(0);
    for (const c of structural) {
      expect(c.basis).toBe('STRUCTURAL_GUARANTEE');
      expect(c.blocking).toBe(true);
    }
  });

  it('read-only blocking conditions are labelled RUNTIME_OBSERVED', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const observed = report.conditions.filter((c) => c.category === 'READ_ONLY_VERIFIABLE');
    expect(observed.length).toBeGreaterThan(0);
    for (const c of observed) expect(c.basis).toBe('RUNTIME_OBSERVED');
  });
});

describe('liveBuyReadiness — impossible guarantees do NOT block', () => {
  it('does not expose or require an operatorConfirmed field', () => {
    expect(BLOCKING_KEYS).not.toContain('operatorConfirmed' as never);
    const report = evaluateLiveBuyReadiness(fullReady());
    expect(report.conditions.some((c) => c.id === 'operatorConfirmed')).toBe(false);
  });

  it('the first-controlled-BUY evidence is pending and never blocks', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const empirical = report.conditions.filter((c) => c.category === 'REQUIRES_CONTROLLED_REAL_BUY');
    expect(empirical.length).toBeGreaterThan(0);
    for (const c of empirical) {
      expect(c.blocking).toBe(false);
      expect(c.status).toBe('PENDING_FIRST_BUY');
    }
    expect(report.liveBuyAllowed).toBe(true);
  });

  it('provided first-BUY evidence is reported as OBSERVED but still never blocks', () => {
    const report = evaluateLiveBuyReadiness(fullReady(), {
      buyLimitAccepted: true,
      buyExchangeOrderIdReturned: true,
      buyOrderObservable: true,
      quoteHoldObserved: true,
      buyLifecycleObserved: true,
    });
    const empirical = report.conditions.filter((c) => c.category === 'REQUIRES_CONTROLLED_REAL_BUY');
    expect(empirical.every((c) => c.status === 'OBSERVED' && !c.blocking)).toBe(true);
    expect(report.liveBuyAllowed).toBe(true);
  });

  it('fundamentally-unprovable properties are compensated and never block', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const unprovable = report.conditions.filter((c) => c.category === 'FUNDAMENTALLY_UNPROVABLE');
    expect(unprovable.length).toBe(FUNDAMENTALLY_UNPROVABLE_PROPERTIES.length);
    for (const c of unprovable) {
      expect(c.blocking).toBe(false);
      expect(c.status).toBe('COMPENSATED');
    }
    // Every unprovable property names a real compensating control.
    const controlIds = new Set(SAFETY_COMPENSATIONS.map((c) => c.id));
    for (const u of FUNDAMENTALLY_UNPROVABLE_PROPERTIES) {
      expect(controlIds.has(u.compensatingControlId)).toBe(true);
    }
  });

  it('the safety compensations are enumerated as ACTIVE, non-blocking controls', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const compensations = report.conditions.filter((c) => c.category === 'SAFETY_COMPENSATION');
    expect(compensations.length).toBe(SAFETY_COMPENSATIONS.length);
    for (const c of compensations) {
      expect(c.status).toBe('ACTIVE');
      expect(c.blocking).toBe(false);
    }
    const ids = compensations.map((c) => c.id);
    // The controls that replace the impossible lost-ack / execution guarantees.
    expect(ids).toContain('createdPersistedBeforeSubmit');
    expect(ids).toContain('transactionalManagedReservation');
    expect(ids).toContain('unknownDurableRetainsReservation');
    expect(ids).toContain('unknownBlocksFurtherPlacement');
    expect(ids).toContain('noRetryNoRepriceNoHeuristicMatching');
    expect(ids).toContain('noOpenOrdersAbsenceInference');
    expect(ids).toContain('noAutomaticReattachmentOperatorResolutionRequired');
    expect(ids).toContain('accountingFailClosedOperatorAttestationNonProven');
  });
});

describe('liveBuyReadiness — read-only verifiable projections', () => {
  it('stale data, quote mismatch, insufficient managed cash and a current conflict each block', () => {
    expect(evaluateLiveBuyReadiness({ ...fullReady(), snapshotFresh: false }).blockers).toEqual(['snapshotFresh']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), managedCashSufficient: false }).blockers).toEqual(['managedCashSufficient']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), exchangeQuoteSufficient: false }).blockers).toEqual(['exchangeQuoteSufficient']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), feeCovered: false }).blockers).toEqual(['feeCovered']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), currentExchangeOrderConflictClear: false }).blockers).toEqual(['currentExchangeOrderConflictClear']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), noUnresolvedLiveOrder: false }).blockers).toEqual(['noUnresolvedLiveOrder']);
  });

  it('kill switch, wrong mode and missing real-funds acknowledgement each block', () => {
    expect(evaluateLiveBuyReadiness({ ...fullReady(), killSwitchInactive: false }).blockers).toEqual(['killSwitchInactive']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), tradingModeIsLive: false }).blockers).toEqual(['tradingModeIsLive']);
    expect(evaluateLiveBuyReadiness({ ...fullReady(), realFundsAtRisk: false }).blockers).toEqual(['realFundsAtRisk']);
  });
});

describe('liveBuyReadiness — reservation safety is transactional, not a readiness observation', () => {
  it('no longer exposes a vacuous noConflictingActiveReservation blocking condition', () => {
    // The reconciliation classifier (`reservationDisposition`) can only return
    // RELEASE or RETAIN, never AMBIGUOUS, so a readiness check on AMBIGUOUS could
    // never fire. It was removed rather than reported as an observation.
    expect(BLOCKING_KEYS).not.toContain('noConflictingActiveReservation' as never);
    const report = evaluateLiveBuyReadiness(fullReady());
    expect(report.conditions.some((c) => c.id === 'noConflictingActiveReservation')).toBe(false);
    expect(report.blockers).not.toContain('noConflictingActiveReservation');
  });

  it('represents transactional managed-quote reservation as an ACTIVE safety compensation', () => {
    const report = evaluateLiveBuyReadiness(fullReady());
    const reservationComp = report.conditions.find((c) => c.id === 'transactionalManagedReservation');
    expect(reservationComp).toBeDefined();
    expect(reservationComp!.category).toBe('SAFETY_COMPENSATION');
    expect(reservationComp!.status).toBe('ACTIVE');
    expect(reservationComp!.blocking).toBe(false);
  });

  it('the transactional reservation boundary remains fail-closed (Portfolio.reserveOrder)', () => {
    // The real enforcement is NOT this evaluator: it is the fresh-state,
    // in-lock `Portfolio.reserveOrder` used at submission time. Prove it refuses
    // to over-reserve beyond deployable managed quote.
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100')]]));
    expect(() => p.reserveOrder('live-buy-1', 'CAD', Money.fromString('101'))).toThrow(/exceeds deployable/);
    const ok = p.reserveOrder('live-buy-1', 'CAD', Money.fromString('100'));
    expect(ok.orderReservation('live-buy-1')!.status).toBe('ACTIVE');
    // A second reservation for the SAME order cannot silently double-spend.
    expect(() => ok.reserveOrder('live-buy-1', 'CAD', Money.fromString('1'))).toThrow(/already has a reservation/);
    // Once the deployable pool is consumed, another order cannot reserve it again.
    expect(() => ok.reserveOrder('live-buy-2', 'CAD', Money.fromString('1'))).toThrow(/exceeds deployable/);
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
