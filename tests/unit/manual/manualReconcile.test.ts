/**
 * Gate 9 — two-store crash consistency / deterministic recovery.
 *
 * `propose`/`confirm`/`recordEvidence`/`settle`/`cancel` each touch two separate
 * durable files (portfolio state and the manual-intent store) with NO cross-file
 * atomicity. This suite simulates every crash window and asserts `reconcile`
 * either deterministically repairs it or reports it and fails closed — never
 * fabricating a fill and never auto-releasing a reservation that may have
 * executed.
 */

import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { TestHarness, makeContext, makePortfolio } from './helpers.js';
import { BTC, PRICE } from './helpers.js';

function buyIntent(h: TestHarness): string {
  const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
  if (!proposal.ok) throw new Error('proposal should succeed');
  h.bridge.confirm(proposal.intent.intentId);
  h.bridge.recordEvidence(proposal.intent.intentId, {
    orderId: '1',
    status: 'FILLED',
    filledQuantity: proposal.intent.quantity,
    averagePrice: PRICE,
    fee: Money.fromString('10.00'),
    feeCurrency: 'quote',
  });
  return proposal.intent.intentId;
}

describe('Gate 9 — two-store crash consistency', () => {
  it('Case A: orphan reservation (portfolio reserved, no intent) is detected and NEVER auto-released', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = h.currentPortfolio.reserveOrder('manual-orphan', 'CAD', Money.fromString('500'));
    const report = h.bridge.reconcile();
    const orphan = report.issues.find((i) => i.type === 'ORPHAN_RESERVATION');
    expect(orphan).toBeDefined();
    expect(orphan!.severity).toBe('error');
    expect(report.safeToTrade).toBe(false);
    // Never auto-released (the order may have executed).
    expect(h.port.orderReservation('manual-orphan')!.status).toBe('ACTIVE');
    h.cleanup();
  });

  it('Case B: BUY intent with no active reservation (crash after intent write) is reported, fails closed', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    buyIntent(h);
    // Simulate: the portfolio reservation was never persisted (fresh portfolio).
    h.currentPortfolio = makePortfolio('100000');
    const report = h.bridge.reconcile();
    const missing = report.issues.find((i) => i.type === 'MISSING_BUY_RESERVATION');
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('error');
    expect(report.safeToTrade).toBe(false);
    h.cleanup();
  });

  it('Case C/E: portfolio settled but intent not yet ACCOUNTED is deterministically finalized', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    const intentId = buyIntent(h);
    const intent = h.intentStore.get(intentId)!;
    // Manually apply the order-level settlement to the portfolio ONLY (simulate a
    // crash after the portfolio write, before the intent status write).
    h.currentPortfolio = h.currentPortfolio.settleManualOrder({
      intentId,
      symbol: BTC,
      side: 'BUY',
      quantity: intent.quantity,
      price: PRICE,
      fee: Money.fromString('10.00'),
      orderId: '1',
      evidenceSource: 'exchange_read',
      exchangedValidated: true,
      settlementMode: 'exchange_validated',
      provenanceProof: false,
      operatorConfirmedBy: 'op',
      executedAtMs: 1_000_000_000,
    });
    const report = h.bridge.reconcile();
    const fix = report.issues.find((i) => i.type === 'SETTLEMENT_WITHOUT_STATUS');
    expect(fix).toBeDefined();
    expect(fix!.fixed).toBe(true);
    expect(h.intentStore.get(intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    expect(h.port.manualSettlement(intentId)).not.toBeNull();
    expect(report.safeToTrade).toBe(true);
    h.cleanup();
  });

  it('an ACCOUNTED intent with no recorded settlement is reported (never accepted silently)', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    const intentId = buyIntent(h);
    h.intentStore.save({ ...h.intentStore.get(intentId)!, status: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION' });
    // fresh portfolio with no settlement record.
    h.currentPortfolio = makePortfolio('100000');
    const report = h.bridge.reconcile();
    const issue = report.issues.find((i) => i.type === 'INTENT_ACCOUNTED_WITHOUT_SETTLEMENT');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(report.safeToTrade).toBe(false);
    h.cleanup();
  });

  it('a leaked ACTIVE reservation on a terminal no-fill intent is released exactly once', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    const intentId = buyIntent(h);
    // Force the intent to CANCELED but leave the reservation ACTIVE (crash window).
    h.intentStore.save({ ...h.intentStore.get(intentId)!, status: 'CANCELED', evidence: null });
    const report = h.bridge.reconcile();
    const fix = report.issues.find((i) => i.type === 'LEAKED_RESERVATION');
    expect(fix).toBeDefined();
    expect(fix!.fixed).toBe(true);
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    h.cleanup();
  });

  it('a corrupt manual-intent store is reported as an error, not as "no intents"', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    // Corrupt the store file.
    rmSync(h.intentStore.path, { force: true });
    writeFileSync(h.intentStore.path, '{ invalid');
    const report = h.bridge.reconcile();
    const issue = report.issues.find((i) => i.type === 'CORRUPT_INTENT_STORE');
    expect(issue).toBeDefined();
    expect(report.safeToTrade).toBe(false);
    h.cleanup();
  });

  it('an EVIDENCE_RECORDED intent with a reservation (normal in-progress) is NOT flagged by reconcile', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-rc${Date.now()}-${Math.random()}.json` });
    buyIntent(h);
    const report = h.bridge.reconcile();
    expect(report.safeToTrade).toBe(true);
    expect(report.issues.length).toBe(0);
    h.cleanup();
  });
});
