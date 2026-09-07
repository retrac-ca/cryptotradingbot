/**
 * Gate 9.5 — state-semantics split adversarial regression tests.
 *
 * These assert the ACTUAL security semantics of the new state model and its
 * metadata, NOT mere string replacements. The central invariants:
 *
 *   - ACCOUNTED_WITH_EXCHANGE_VALIDATION: accounting used authoritative exchange
 *     evidence. provenanceProof is ALWAYS false (never exchange-proven provenance).
 *   - ACCOUNTED_WITH_OPERATOR_ATTESTATION: accounting relied on operator
 *     attestation for intent-to-order attribution; provenanceProof is ALWAYS false.
 *   - RECONCILIATION_REQUIRED: evidence consistent but accounting cannot be safely
 *     completed (fee unknown/base, read failure); reservation is retained, no
 *     accounting. DISTINCT from AMBIGUOUS.
 *   - AMBIGUOUS: evidence CONTRADICTS (operator vs exchange mismatch, binding
 *     failure, over-fill); reservation retained, no accounting.
 *   - Terminal zero-fill releases the reservation exactly once.
 *   - Repeated accounting is idempotent; conflicting repeat fails closed.
 *   - Restart preserves the new terminal states (intent status + settlement mode).
 *   - No transition introduces SendOrder/CancelOrder; supportsOrderPlacement=false.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import { OrderRejectedError } from '../../../src/exchanges/errors.js';
import { ManualIntentStore } from '../../../src/manual/index.js';
import { TestHarness, makeContext, exchangeOrder, BTC, PRICE, NOW } from './helpers.js';

/** Build a BUY intent advanced to EVIDENCE_RECORDED with a quote-fee order seeded. */
function readyHarness(): { h: TestHarness; intentId: string } {
  const h = new TestHarness({ intentFilePath: `/tmp/opencode/g95-${Date.now()}-${Math.random()}.json` });
  const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
  if (!proposal.ok) throw new Error('proposal should succeed');
  const intentId = proposal.intent.intentId;
  h.bridge.confirm(intentId);
  h.bridge.recordEvidence(intentId, {
    orderId: '1',
    status: 'FILLED',
    filledQuantity: proposal.intent.quantity,
    averagePrice: PRICE,
    fee: Money.fromString('10.00'),
    feeCurrency: 'quote',
    evidenceSource: 'exchange_read',
  });
  h.seedOrder(
    exchangeOrder({
      exchangeOrderId: '1',
      quantity: proposal.intent.quantity,
      filledQuantity: proposal.intent.quantity,
      averagePrice: PRICE,
      fee: Money.fromString('10.00'),
      feeCurrency: 'quote',
      status: 'FILLED',
      createdAtMs: NOW,
      updatedAtMs: NOW,
      side: 'BUY',
      symbol: BTC,
    }),
  );
  return { h, intentId };
}

describe('Gate 9.5 — accounting authority vs provenance', () => {
  it('A: exchange-validated accounting enters ACCOUNTED_WITH_EXCHANGE_VALIDATION with exchange_validated mode and provenanceProof=false', async () => {
    const { h, intentId } = readyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    expect(h.intentStore.get(intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const s = h.port.manualSettlement(intentId)!;
    expect(s.settlementMode).toBe('exchange_validated');
    expect(s.provenanceProof).toBe(false);
    expect(s.exchangedValidated).toBe(true);
    expect(h.port.cash('CAD').toString()).toBe('94990.00000000');
    h.cleanup();
  });

  it('B: operator-attested accounting enters ACCOUNTED_WITH_OPERATOR_ATTESTATION with operator_attested mode', async () => {
    const { h, intentId } = readyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: true, accountingAuthority: 'operator_attestation', operator: 'human' });
    expect(out.outcome).toBe('ACCOUNTED_WITH_OPERATOR_ATTESTATION');
    expect(h.intentStore.get(intentId)!.status).toBe('ACCOUNTED_WITH_OPERATOR_ATTESTATION');
    const s = h.port.manualSettlement(intentId)!;
    expect(s.settlementMode).toBe('operator_attested');
    expect(s.provenanceProof).toBe(false);
    expect(s.operatorConfirmedBy).toBe('human');
    // Accounting still applied exactly once (operator attestation does not relax accounting).
    expect(h.port.cash('CAD').toString()).toBe('94990.00000000');
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    h.cleanup();
  });

  it('C: operator-attested accounting never carries provenanceProof=true', async () => {
    const { h, intentId } = readyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: true, accountingAuthority: 'operator_attestation' });
    expect(out.outcome).toBe('ACCOUNTED_WITH_OPERATOR_ATTESTATION');
    const s = h.port.manualSettlement(intentId)!;
    expect(s.provenanceProof).toBe(false);
    // The intent state is NOT named as provenance, and the settlement carries no execution id.
    expect('executionId' in s).toBe(false);
    h.cleanup();
  });

  it('D: exchange validation does NOT imply provenanceProof=true', async () => {
    const { h, intentId } = readyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const s = h.port.manualSettlement(intentId)!;
    expect(s.provenanceProof).toBe(false);
    expect(s.exchangedValidated).toBe(true); // exchange validated, but NOT provenance-proven
    h.cleanup();
  });
});

describe('Gate 9.5 — fee semantics fail closed into RECONCILIATION_REQUIRED', () => {
  it('E: an unknown-currency non-zero fee enters RECONCILIATION_REQUIRED (NOT accounting success)', async () => {
    const { h, intentId } = readyHarness();
    const intent = h.intentStore.get(intentId)!;
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: intent.quantity, averagePrice: PRICE });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1',
        quantity: intent.quantity,
        filledQuantity: intent.quantity,
        averagePrice: PRICE,
        fee: Money.fromString('10.00'),
        feeCurrency: 'unknown', // real NDAX order-status shape
        status: 'FILLED',
        side: 'BUY',
        symbol: BTC,
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(h.intentStore.get(intentId)!.status).toBe('RECONCILIATION_REQUIRED');
    expect(h.port.manualSettlement(intentId)).toBeNull(); // NO accounting applied
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    expect(h.port.orderReservation(intentId)!.status).toBe('ACTIVE'); // retained
    expect(h.port.reserved('CAD').isPositive()).toBe(true);
    h.cleanup();
  });

  it('F: a base-denominated fee never becomes a quote fee', async () => {
    const { h, intentId } = readyHarness();
    const intent = h.intentStore.get(intentId)!;
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: intent.quantity, averagePrice: PRICE });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1',
        quantity: intent.quantity,
        filledQuantity: intent.quantity,
        averagePrice: PRICE,
        fee: Money.fromString('10.00'),
        feeCurrency: 'base',
        status: 'FILLED',
        side: 'BUY',
        symbol: BTC,
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(h.port.manualSettlement(intentId)).toBeNull();
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    h.cleanup();
  });

  it('G: execution-level enumeration is NEVER used for order-level accounting (no executionId in settlement)', async () => {
    const { h, intentId } = readyHarness();
    await h.bridge.settle(intentId, { confirmSettle: true });
    const s = h.port.manualSettlement(intentId)!;
    // Order-level accounting is aggregate-only and never fabricates/uses an execution id.
    expect('executionId' in s).toBe(false);
    expect('tradeId' in s).toBe(false);
    expect(Object.keys(s)).not.toContain('executionId');
    expect(s.orderId).toBe('1');
    expect(s.intentId).toBe(intentId);
    // The execution-identity idempotency ledger (applyLiveFill path) is untouched:
    // manual accounting never routes through execution-level deduplication.
    expect(h.port.stateModel.appliedExecutions.size).toBe(0);
    expect(h.port.manualSettlementsView().size).toBe(1);
    h.cleanup();
  });
});

describe('Gate 9.5 — AMBIGUOUS vs RECONCILIATION_REQUIRED vs reservation', () => {
  it('H: contradictory evidence (operator fill != exchange fill) enters AMBIGUOUS and retains reservation', async () => {
    const { h, intentId } = readyHarness();
    // operator claims a DIFFERENT fill than the authoritative exchange order.
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: Money.fromString('0.01'), averagePrice: PRICE });
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('AMBIGUOUS');
    expect(h.intentStore.get(intentId)!.status).toBe('AMBIGUOUS');
    expect(h.port.manualSettlement(intentId)).toBeNull();
    expect(h.port.orderReservation(intentId)!.status).toBe('ACTIVE'); // retained
    h.cleanup();
  });

  it('J: AMBIGUOUS is not a synonym for fee-unavailable — a contradictory order stays AMBIGUOUS', async () => {
    const { h, intentId } = readyHarness();
    const intent = h.intentStore.get(intentId)!;
    // Binding fails cleanly (an unrelated order predating the proposal).
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: intent.quantity, averagePrice: PRICE });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1',
        quantity: intent.quantity,
        filledQuantity: intent.quantity,
        averagePrice: PRICE,
        fee: Money.fromString('10.00'),
        feeCurrency: 'quote',
        status: 'FILLED',
        side: 'BUY',
        symbol: BTC,
        createdAtMs: intent.createdAtMs - 100_000, // pre-proposal => unrelated
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('AMBIGUOUS');
    expect(h.port.orderReservation(intentId)!.status).toBe('ACTIVE');
    h.cleanup();
  });

  it('K: terminal zero-fill releases the reservation exactly once (CANCELED)', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g95-k${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'CANCELED', filledQuantity: Money.zero(), averagePrice: null, feeCurrency: 'quote' });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1',
        quantity: proposal.intent.quantity,
        filledQuantity: Money.zero(),
        averagePrice: null,
        fee: Money.fromString('40.00'),
        feeCurrency: 'quote',
        status: 'CANCELED',
        side: 'BUY',
        symbol: BTC,
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('CANCELED_TERMINAL_NO_FILL');
    expect(h.intentStore.get(intentId)!.status).toBe('CANCELED');
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    // releasing again is a safe no-op (exactly once).
    expect(h.port.releaseOrderReservation(intentId).reserved('CAD').isZero()).toBe(true);
    h.cleanup();
  });
});

describe('Gate 9.5 — idempotency, restart, persistence', () => {
  it('L: repeated accounting is idempotent (no double application)', async () => {
    const { h, intentId } = readyHarness();
    const first = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(first.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const cash = h.port.cash('CAD').toString();
    const settled = h.port.manualSettlement(intentId)!;
    // bridge re-settle refuses (terminal)
    const again = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(again.outcome).toBe('REFUSED');
    expect(h.port.cash('CAD').toString()).toBe(cash);
    // portfolio identical-repeat is a no-op
    const same = h.port.settleManualOrder({
      intentId,
      symbol: BTC,
      side: 'BUY',
      quantity: settled.quantity,
      price: settled.price,
      fee: settled.fee,
      orderId: settled.orderId,
      evidenceSource: settled.evidenceSource,
      exchangedValidated: true,
      settlementMode: settled.settlementMode,
      provenanceProof: false,
      operatorConfirmedBy: settled.operatorConfirmedBy,
      executedAtMs: settled.executedAtMs,
    });
    expect(same).toBe(h.port);
    expect(h.port.cash('CAD').toString()).toBe(cash);
    h.cleanup();
  });

  it('M: conflicting repeated accounting is rejected', async () => {
    const { h, intentId } = readyHarness();
    await h.bridge.settle(intentId, { confirmSettle: true });
    const settled = h.port.manualSettlement(intentId)!;
    expect(() =>
      h.port.settleManualOrder({
        intentId,
        symbol: BTC,
        side: 'BUY',
        quantity: Money.fromString('0.3'), // different quantity
        price: settled.price,
        fee: settled.fee,
        orderId: settled.orderId,
        evidenceSource: settled.evidenceSource,
        exchangedValidated: true,
        settlementMode: settled.settlementMode,
        provenanceProof: false,
        operatorConfirmedBy: settled.operatorConfirmedBy,
        executedAtMs: settled.executedAtMs,
      }),
    ).toThrow(/different payload/);
    h.cleanup();
  });

  it('N: restart preserves the new terminal states (intent status + settlement mode)', async () => {
    const { h, intentId } = readyHarness();
    await h.bridge.settle(intentId, { confirmSettle: true });
    // Reload the intent store from the same path (simulate process restart).
    const reloadedStore = new ManualIntentStore(h.intentStore.path);
    expect(reloadedStore.get(intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    // Serialize/deserialize the portfolio so the manual settlement round-trips.
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(h.port.stateModel)));
    const s = restored.manualSettlement(intentId)!;
    expect(s.settlementMode).toBe('exchange_validated');
    expect(s.provenanceProof).toBe(false);
    expect(restored.cash('CAD').toString()).toBe(h.port.cash('CAD').toString());
    h.cleanup();
  });

  it('O: a v2 store holding the old SETTLED status fails closed (not silently migrated)', () => {
    const p = `/tmp/opencode/g95-c${Date.now()}-${Math.random()}.json`;
    rmSync(p, { force: true });
    rmSync(`${p}.tmp`, { force: true });
    mkdirSync('/tmp/opencode', { recursive: true });
    const intent = {
      intentId: 'manual-i1',
      status: 'SETTLED', // invalid for a v2 file
      symbol: 'BTC/CAD',
      side: 'BUY',
      type: 'market',
      quantity: '0.12500000',
      limitPrice: null,
      tif: null,
      reason: 'x',
      riskSnapshot: {
        symbol: 'BTC/CAD', side: 'BUY', type: 'market', referencePrice: '40000.00000000',
        estimatedNotional: '5000.00000000', estimatedFee: '10.00000000', quoteCurrency: 'CAD',
        requiredBalance: '5010.00000000', deployableQuoteAtProposal: '100000.00000000',
        portfolioValueAtProposal: '50000.00000000', peakPortfolioValueAtProposal: '50000.00000000',
        portfolioExposureAtProposal: '0.00000000', currentPositionAtProposal: '0.00000000',
        openManagedPositionCountAtProposal: 0, appliedLimits: {},
        marketDataTimestampMs: 1, marketDataObservedAtMs: 1, proposalTimeMs: 1,
      },
      evidence: null, operatorConfirmedBy: null, createdAtMs: 1, updatedAtMs: 1,
      events: [], reservationCurrency: null, reservationAmount: null,
    };
    writeFileSync(p, JSON.stringify({ format: 'retrac-state', version: 1, realm: 'live', domain: 'manual-intents', savedAtMs: 1, payload: { version: 2, intents: { 'manual-i1': intent }, savedAtMs: 1 } }));
    const store = new ManualIntentStore(p);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(/invalid status/);
    rmSync(p, { force: true });
  });

  it('O2: a v1 store with old SETTLED migrates to ACCOUNTED_WITH_EXCHANGE_VALIDATION', () => {
    const p = `/tmp/opencode/g95-m${Date.now()}-${Math.random()}.json`;
    rmSync(p, { force: true });
    rmSync(`${p}.tmp`, { force: true });
    mkdirSync('/tmp/opencode', { recursive: true });
    const intent = {
      intentId: 'manual-i1', status: 'SETTLED', symbol: 'BTC/CAD', side: 'BUY', type: 'market',
      quantity: '0.12500000', limitPrice: null, tif: null, reason: 'x',
      riskSnapshot: {
        symbol: 'BTC/CAD', side: 'BUY', type: 'market', referencePrice: '40000.00000000',
        estimatedNotional: '5000.00000000', estimatedFee: '10.00000000', quoteCurrency: 'CAD',
        requiredBalance: '5010.00000000', deployableQuoteAtProposal: '100000.00000000',
        portfolioValueAtProposal: '50000.00000000', peakPortfolioValueAtProposal: '50000.00000000',
        portfolioExposureAtProposal: '0.00000000', currentPositionAtProposal: '0.00000000',
        openManagedPositionCountAtProposal: 0, appliedLimits: {},
        marketDataTimestampMs: 1, marketDataObservedAtMs: 1, proposalTimeMs: 1,
      },
      evidence: null, operatorConfirmedBy: null, createdAtMs: 1, updatedAtMs: 1,
      events: [], reservationCurrency: null, reservationAmount: null,
    };
    writeFileSync(p, JSON.stringify({ format: 'retrac-state', version: 1, realm: 'live', domain: 'manual-intents', savedAtMs: 1, payload: { version: 1, intents: { 'manual-i1': intent }, savedAtMs: 1 } }));
    const store = new ManualIntentStore(p);
    const file = store.load();
    expect(file.status).toBe('OK');
    if (file.status === 'OK') {
      expect(file.data.version).toBe(2);
      expect(file.data.intents['manual-i1']!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    }
    rmSync(p, { force: true });
  });
});

describe('Gate 9.5 — PENDING keeps reservation; retry path', () => {
  it('a non-terminal (OPEN) order settles into PENDING with reservation retained', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g95-p${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, {
      orderId: '1', status: 'OPEN',
      filledQuantity: Money.zero(), averagePrice: null, feeCurrency: 'quote',
    });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1',
        quantity: proposal.intent.quantity,
        filledQuantity: Money.zero(),
        averagePrice: null,
        fee: Money.fromString('40.00'),
        feeCurrency: 'quote',
        status: 'OPEN',
        side: 'BUY',
        symbol: BTC,
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('PENDING');
    expect(h.intentStore.get(intentId)!.status).toBe('PENDING');
    expect(h.port.orderReservation(intentId)!.status).toBe('ACTIVE'); // retained (may still fill)
    expect(h.port.manualSettlement(intentId)).toBeNull();
    h.cleanup();
  });

  it('a PENDING order that once becomes terminal can be re-settled into ACCOUNTED', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g95-pr${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, {
      orderId: '1', status: 'FILLED',
      filledQuantity: proposal.intent.quantity, averagePrice: PRICE, fee: Money.fromString('10.00'), feeCurrency: 'quote',
    });
    // First read is still open/partial.
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1', quantity: proposal.intent.quantity, filledQuantity: Money.zero(),
        averagePrice: null, fee: Money.fromString('40.00'), feeCurrency: 'quote',
        status: 'OPEN', side: 'BUY', symbol: BTC,
      }),
    );
    const first = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(first.outcome).toBe('PENDING');
    expect(h.intentStore.get(intentId)!.status).toBe('PENDING');
    // Now the exchange reports it as FILLED (terminal); re-settle succeeds.
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '1', quantity: proposal.intent.quantity, filledQuantity: proposal.intent.quantity,
        averagePrice: PRICE, fee: Money.fromString('10.00'), feeCurrency: 'quote',
        status: 'FILLED', side: 'BUY', symbol: BTC,
      }),
    );
    const second = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(second.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    expect(h.intentStore.get(intentId)!.status).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    h.cleanup();
  });
});

describe('Gate 9.5 — no order-placement wiring', () => {
  it('P: the full manual lifecycle never calls placeOrder/cancelOrder', async () => {
    const { h, intentId } = readyHarness();
    let placeCalls = 0;
    let cancelCalls = 0;
    const origPlace = FakeExchange.prototype.placeOrder;
    const origCancel = FakeExchange.prototype.cancelOrder;
    FakeExchange.prototype.placeOrder = function () {
      placeCalls += 1;
      throw new Error('must never place');
    };
    FakeExchange.prototype.cancelOrder = function () {
      cancelCalls += 1;
      throw new Error('must never cancel');
    };
    try {
      await h.bridge.settle(intentId, { confirmSettle: true });
      expect(placeCalls).toBe(0);
      expect(cancelCalls).toBe(0);
    } finally {
      FakeExchange.prototype.placeOrder = origPlace;
      FakeExchange.prototype.cancelOrder = origCancel;
      h.cleanup();
    }
  });

  it('Q: supportsOrderPlacement remains false on the real NDAX adapter and placement throws', async () => {
    const adapter = new NdaxAdapter({ credentials: { apiKey: '', apiSecret: '', userId: '' } });
    expect(adapter.capabilities.supportsOrderPlacement).toBe(false);
    await expect(adapter.placeOrder({ symbol: BTC, side: 'BUY', type: 'market', quantity: Money.fromString('0.01'), clientOrderId: 'x', reason: 'x' })).rejects.toThrow(OrderRejectedError);
    await expect(adapter.cancelOrder(BTC, '1')).rejects.toThrow(OrderRejectedError);
  });
});
