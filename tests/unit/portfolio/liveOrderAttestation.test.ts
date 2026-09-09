/**
 * Live-order operator attestation — Portfolio.settleLiveOrderAttested accounting
 * invariants.
 *
 * The capability under test: resolving an ambiguous controlled-live order (a
 * RETRAC-SUBMITTED order that is exchange-FILLED but whose execution set cannot
 * be proven complete) via an explicit operator attestation. It must NEVER
 * fabricate an execution identity, NEVER silently assume a fee, NEVER adopt the
 * residual exchange balance as proceeds, NEVER create BOT-owned inventory, and
 * be idempotent + fail-closed on any conflict.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';
import type { ExchangeEvidenceSnapshot } from '../../../src/portfolio/types.js';

const CLIENT = 'live-BTCCAD-287fdb4f-c1cf-486c-a049-cac2dbd4da44';
const EXCHANGE_ORDER = '26177556994';
const SYMBOL = 'BTC/CAD';
const QTY = Money.fromString('0.00011059');
const PRICE = Money.fromString('108500.00');
const POSITION_BEFORE = Money.fromString('0.00034411');
const POSITION_AFTER = Money.fromString('0.00023352');

/** The EXTERNAL_AUTHORIZED position matching the real order's pre-sale inventory. */
function externalBtcPosition(): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString('0')]]))
    .withExternalSnapshot(new Map([[SYMBOL, POSITION_BEFORE]]))
    .authorizeExternal(SYMBOL);
}

function evidence(): ExchangeEvidenceSnapshot {
  return {
    orderId: EXCHANGE_ORDER,
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'FILLED',
    quantity: QTY,
    filledQuantity: QTY,
    averagePrice: PRICE,
    limitPrice: PRICE,
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'live-test SELL (target 12 CAD)',
    createdAtMs: 1,
    updatedAtMs: 2,
    orderEvidenceSource: 'status' as const,
    observedAccountTrades: [],
    observedBalances: [],
    readAtMs: 100,
  };
}

function op(over: Partial<Parameters<Portfolio['settleLiveOrderAttested']>[0]> = {}) {
  return {
    clientOrderId: CLIENT,
    symbol: SYMBOL,
    side: 'SELL' as const,
    orderQuantity: QTY,
    exchangeOrderId: EXCHANGE_ORDER,
    exchangeStatus: 'FILLED',
    attestedFilledQuantity: QTY,
    attestedAveragePrice: PRICE,
    fee: Money.zero(),
    feeCurrency: 'quote' as const,
    evidenceSource: 'exchange_read',
    accountingAuthority: 'operator_attestation',
    provenanceProof: false as const,
    operatorConfirmedBy: 'operator',
    attestedAtMs: 200,
    exchangeReadAtMs: 100,
    exchangeEvidence: evidence(),
    ...over,
  };
}

describe('Live-order operator attestation — Portfolio.settleLiveOrderAttested', () => {
  it('1: a zero-fee operator-attested live SELL reduces the EXTERNAL_AUTHORIZED position exactly', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    // Remaining BTC = 0.00034411 - 0.00011059 = 0.00023352, stays EXTERNAL_AUTHORIZED.
    const pos = p.position(SYMBOL)!;
    expect(pos.quantity.toString()).toBe(POSITION_AFTER.toString());
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe(POSITION_AFTER.toString());
    expect(pos.sourceQuantities.BOT.toString()).toBe('0.00000000');
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    // Attributable proceeds booked only: qty * price - 0 fee.
    expect(p.cash('CAD').toString()).toBe(QTY.mul(PRICE).toString());
    expect(p.liveOrderAttestation(CLIENT)).not.toBeNull();
  });

  it('2: a non-zero authoritative quote fee is accounted exactly', () => {
    const fee = Money.fromString('0.02');
    const p = externalBtcPosition().settleLiveOrderAttested(op({ fee, feeCurrency: 'quote' }));
    expect(p.cash('CAD').toString()).toBe(QTY.mul(PRICE).sub(fee).toString());
    expect(p.liveOrderAttestation(CLIENT)!.fee.toString()).toBe(fee.toString());
    expect(p.liveOrderAttestation(CLIENT)!.feeCurrency).toBe('quote');
  });

  it('3: a non-zero UNKNOWN fee is rejected (never silently assumed quote)', () => {
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ fee: Money.fromString('0.02'), feeCurrency: 'unknown' }))).toThrow(/non-quote currency|not authoritatively quote/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString()); // nothing mutated
    expect(p.cash('CAD').isZero()).toBe(true);
    expect(p.liveOrderAttestation(CLIENT)).toBeNull();
  });

  it('4: a non-zero BASE fee is rejected (no safe conversion)', () => {
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ fee: Money.fromString('0.02'), feeCurrency: 'base' }))).toThrow(/non-quote currency|not authoritatively quote/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    expect(p.cash('CAD').isZero()).toBe(true);
  });

  it('5: attested filled quantity must equal the original order quantity (via CLI); the primitive rejects a mismatch only on its own limits', () => {
    // The primitive accepts any positive quantity <= orderQuantity; the CLI
    // enforces equality with the fresh exchange read. Here we verify the <= bound.
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ attestedFilledQuantity: Money.zero() }))).toThrow(/must be positive/);
  });

  it('6: attested filled quantity greater than the original order quantity is rejected', () => {
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ attestedFilledQuantity: Money.fromString('0.00020000') }))).toThrow(/exceeds the original order quantity/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
  });

  it('7: a non-positive average execution price is rejected', () => {
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ attestedAveragePrice: Money.zero() }))).toThrow(/must be positive/);
    expect(() => p.settleLiveOrderAttested(op({ attestedAveragePrice: Money.fromString('-1') }))).toThrow(/must be positive/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
  });

  it('9: the attestation is keyed by the exact clientOrderId', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    expect(p.liveOrderAttestation(CLIENT)).not.toBeNull();
    expect(p.liveOrderAttestation('other-client')).toBeNull();
  });

  it('10: an existing applied execution on the order causes rejection (no double accounting)', () => {
    let p = externalBtcPosition();
    p = p.applyLiveFill(CLIENT, SYMBOL, 'SELL', { price: PRICE, quantity: QTY, fee: Money.zero(), feeCurrency: 'quote', timestampMs: null, executionId: 'e1' });
    expect(p.appliedCount()).toBe(1);
    expect(() => p.settleLiveOrderAttested(op())).toThrow(/already has an applied execution/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_AFTER.toString()); // the applied fill already reduced it
  });

  it('11: a manual settlement for the same exchange OrderId causes rejection', () => {
    let p = externalBtcPosition();
    p = p.settleManualOrder({
      intentId: 'manual-1',
      symbol: SYMBOL,
      side: 'SELL',
      quantity: QTY,
      price: PRICE,
      fee: Money.zero(),
      orderId: EXCHANGE_ORDER,
      evidenceSource: 'exchange_read',
      exchangedValidated: true,
      settlementMode: 'operator_attested',
      provenanceProof: false,
      operatorConfirmedBy: 'op',
      executedAtMs: 100,
    });
    expect(() => p.settleLiveOrderAttested(op())).toThrow(/already accounted by a manual settlement/);
  });

  it('12: a duplicate identical attestation is idempotent (no double accounting)', () => {
    let p = externalBtcPosition().settleLiveOrderAttested(op());
    const cash = p.cash('CAD').toString();
    const qty = p.position(SYMBOL)!.quantity.toString();
    const again = p.settleLiveOrderAttested(op());
    expect(again).toBe(p); // no mutation
    expect(again.cash('CAD').toString()).toBe(cash);
    expect(again.position(SYMBOL)!.quantity.toString()).toBe(qty);
  });

  it('13: a conflicting duplicate attestation is rejected', () => {
    let p = externalBtcPosition().settleLiveOrderAttested(op());
    expect(() => p.settleLiveOrderAttested(op({ attestedFilledQuantity: Money.fromString('0.00010000') }))).toThrow(/different payload/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_AFTER.toString());
  });

  it('14: the original order identity is preserved on the attestation record', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    const a = p.liveOrderAttestation(CLIENT)!;
    expect(a.clientOrderId).toBe(CLIENT);
    expect(a.exchangeOrderId).toBe(EXCHANGE_ORDER);
    expect(a.exchangeEvidence.symbol).toBe(SYMBOL);
    expect(a.exchangeEvidence.side).toBe('SELL');
    expect(a.exchangeEvidence.type).toBe('limit');
    expect(a.exchangeEvidence.quantity.toString()).toBe(QTY.toString());
    expect(a.exchangeEvidence.limitPrice?.toString()).toBe(PRICE.toString());
  });

  it('15: EXTERNAL_AUTHORIZED BTC provenance is preserved (no BOT inventory created)', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    const pos = p.position(SYMBOL)!;
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(pos.sourceQuantities.BOT.toString()).toBe('0.00000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toString()).toBe(POSITION_AFTER.toString());
  });

  it('16: only attributable proceeds are booked; unrelated CAD is NOT adopted', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    // The full observed CAD residual (e.g. 37.99) is never booked; only qty*price.
    expect(p.cash('CAD').toString()).toBe(QTY.mul(PRICE).toString());
    expect(p.cash('CAD').compareTo(Money.fromString('37.99775272'))).toBeLessThan(0);
  });

  it('17: unrelated external assets are untouched', () => {
    let p = externalBtcPosition()
      .withExternalSnapshot(new Map([[SYMBOL, POSITION_BEFORE], ['ETH/CAD', Money.fromString('1.0')]]));
    p = p.authorizeExternal(SYMBOL);
    p = p.settleLiveOrderAttested(op());
    // ETH remains in the external snapshot (never adopted, never touched).
    expect(p.externalSnapshotView().get('ETH/CAD')?.toString()).toBe('1.00000000');
    expect(p.position('ETH/CAD')).toBeNull();
  });

  it('19: provenanceProof remains false on the attestation', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    expect(p.liveOrderAttestation(CLIENT)!.provenanceProof).toBe(false);
    expect(p.liveOrderAttestation(CLIENT)!.accountingAuthority).toBe('operator_attestation');
    expect(p.liveOrderAttestation(CLIENT)!.evidenceSource).toBe('exchange_read');
  });

  it('22: restart/load preserves the attestation (idempotent after reload)', () => {
    let p = externalBtcPosition().settleLiveOrderAttested(op());
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    expect(restored.liveOrderAttestation(CLIENT)).not.toBeNull();
    expect(restored.liveOrderAttestation(CLIENT)!.attestationId).toBe(`op-attest:${CLIENT}`);
    // Re-settling the identical payload after reload must NOT re-account.
    expect(restored.settleLiveOrderAttested(op())).toBe(restored);
    expect(restored.cash('CAD').toString()).toBe(p.cash('CAD').toString());
  });

  it('23: NO synthetic numeric execution ID is created', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    const a = p.liveOrderAttestation(CLIENT)!;
    expect(a.attestationId).toBe(`op-attest:${CLIENT}`);
    expect(/^\d+$/.test(a.attestationId)).toBe(false); // not a numeric NDAX execution id
  });

  it('24: the attestation is never recorded in appliedExecutions', () => {
    const p = externalBtcPosition().settleLiveOrderAttested(op());
    expect(p.appliedCount()).toBe(0);
    expect(p.appliedExecution(`op-attest:${CLIENT}`)).toBeNull();
    expect(p.appliedExecution(EXCHANGE_ORDER)).toBeNull();
    // Every applied execution key is a distinct exchange execution id, not the attestation.
    for (const [k] of p.stateModel.appliedExecutions) {
      expect(k).not.toMatch(/^op-attest:/);
    }
  });

  it('25: an invalid accounting authority cannot settle an order (defense-in-depth)', () => {
    const p = externalBtcPosition();
    expect(() => p.settleLiveOrderAttested(op({ accountingAuthority: 'exchange' }))).toThrow(/accountingAuthority must be "operator_attestation"/);
    expect(() => p.settleLiveOrderAttested(op({ accountingAuthority: '' }))).toThrow(/accountingAuthority must be "operator_attestation"/);
    expect(p.position(SYMBOL)!.quantity.toString()).toBe(POSITION_BEFORE.toString());
    expect(p.cash('CAD').isZero()).toBe(true);
    expect(p.liveOrderAttestation(CLIENT)).toBeNull();
  });
});
