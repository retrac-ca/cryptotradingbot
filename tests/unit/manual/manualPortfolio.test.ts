/**
 * Gate 9 — fee-currency semantics + Portfolio.settleManualOrder reservation and
 * accounting invariants.
 *
 * Accounting writes the fee in the QUOTE currency only. A base-denominated fee,
 * or the ABSENCE of an authoritative exchange fee, must fail closed; an
 * operator-reported or modelled fee is NEVER authoritative and is never silently
 * reinterpreted as quote.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';
import { TestHarness, makeContext, exchangeOrder } from './helpers.js';
import { BTC, PRICE } from './helpers.js';

function port(cash: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
}

function settleOp(over: Partial<Parameters<Portfolio['settleManualOrder']>[0]> = {}) {
  const base = {
    intentId: 'manual-1',
    symbol: BTC,
    side: 'BUY' as const,
    quantity: Money.fromString('0.12500000'),
    price: PRICE,
    fee: Money.fromString('10.00'),
    orderId: '999001',
    evidenceSource: 'exchange_read',
    exchangedValidated: true,
    settlementMode: 'exchange_validated' as const,
    provenanceProof: false as const,
    operatorConfirmedBy: 'op',
    executedAtMs: 1_000_000_000,
  };
  return { ...base, ...over };
}

describe('Gate 9 — Portfolio.settleManualOrder reservation accounting', () => {
  it('ONE external OrderId can never be accounted by TWO different intents (duplicate accounting guard)', () => {
    // A real exchange order is one fill. Two intents must not both account it.
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp({ intentId: 'manual-1', orderId: '999001' }));
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000');
    expect(p.cash('CAD').toString()).toBe('94990.00000000');
    // The SAME portfolio: a second, DIFFERENT intent attempts to account the SAME
    // external OrderId -> refused before any mutation (no double-charge, no double position).
    p = p.reserveOrder('manual-2', 'CAD', Money.fromString('5010.00'));
    expect(() => p.settleManualOrder(settleOp({ intentId: 'manual-2', orderId: '999001' }))).toThrow(/already accounted by a different intent/);
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000'); // NOT doubled
    expect(p.orderReservation('manual-2')!.status).toBe('ACTIVE'); // retained (not consumed)
    expect(p.manualSettlement('manual-2')).toBeNull(); // never accounted
    expect(p.cash('CAD').toString()).toBe('94990.00000000'); // no second cash reduction
    // A DIFFERENT OrderId for a different intent is fine.
    p = p.settleManualOrder(settleOp({ intentId: 'manual-2', orderId: '999002' }));
    expect(p.position(BTC)!.quantity.toString()).toBe('0.25000000');
    expect(p.cash('CAD').toString()).toBe('89980.00000000');
    expect(p.orderReservation('manual-2')!.status).toBe('RELEASED');
  });

  it('the duplicate guard is not bypassed by a representation-different but numerically-identical OrderId', () => {
    // NDAX order ids are integers and the adapter queries them via `Number`, so
    // "999001" and "0999001" denote the SAME real order. The guard must compare
    // them as the same external order, not as unrelated strings.
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp({ intentId: 'manual-1', orderId: '999001' }));
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000');
    // A second intent attempts the SAME order typed with a leading zero.
    p = p.reserveOrder('manual-2', 'CAD', Money.fromString('5010.00'));
    expect(() => p.settleManualOrder(settleOp({ intentId: 'manual-2', orderId: '0999001' }))).toThrow(
      /already accounted by a different intent/,
    );
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000'); // NOT doubled
    expect(p.cash('CAD').toString()).toBe('94990.00000000'); // no second cash reduction
    expect(p.orderReservation('manual-2')!.status).toBe('ACTIVE'); // retained (not consumed)
    expect(p.manualSettlement('manual-2')).toBeNull(); // never accounted
  });

  it('a same-intent retry with a representation-different but numerically-identical OrderId is idempotent', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp({ intentId: 'manual-1', orderId: '999001' }));
    const cash = p.cash('CAD').toString();
    // Re-typing the same real order as "0999001" must NOT count as a conflicting
    // payload: it is the same order, so the identical settlement stays a no-op.
    expect(p.settleManualOrder(settleOp({ intentId: 'manual-1', orderId: '0999001' }))).toBe(p);
    expect(p.cash('CAD').toString()).toBe(cash);
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000');
  });

  it('a BUY consumes the reservation by the actual aggregate cost and releases it exactly once', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp());
    // cash = 100000 - (0.125*40000 + 10) = 94990.
    expect(p.cash('CAD').toString()).toBe('94990.00000000');
    expect(p.position(BTC)!.quantity.toString()).toBe('0.12500000');
    const res = p.orderReservation('manual-1')!;
    expect(res.status).toBe('RELEASED');
    expect(res.remaining.isZero()).toBe(true);
    expect(p.reserved('CAD').isZero()).toBe(true);
    // Double release is a safe no-op (idempotent).
    expect(p.releaseOrderReservation('manual-1').reserved('CAD').isZero()).toBe(true);
  });

  it('a BUY with NO active reservation fails closed (would otherwise consume un-reserved cash)', () => {
    const p = port('100000');
    expect(() => p.settleManualOrder(settleOp())).toThrow(/no active reservation/);
    // Nothing mutated.
    expect(p.cash('CAD').toString()).toBe('100000.00000000');
    expect(p.position(BTC)).toBeNull();
  });

  it('an under-reserved BUY fails closed and never mutates (cash/position/reservation intact)', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('100.00'));
    expect(() => p.settleManualOrder(settleOp())).toThrow(/under-reserved/);
    expect(p.cash('CAD').toString()).toBe('100000.00000000');
    expect(p.position(BTC)).toBeNull();
    expect(p.orderReservation('manual-1')!.status).toBe('ACTIVE');
    expect(p.orderReservation('manual-1')!.remaining.toString()).toBe('100.00000000');
  });

  it('a repeated identical settlement is a no-op; a conflicting repeat throws', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp());
    const cash = p.cash('CAD').toString();
    expect(p.settleManualOrder(settleOp())).toBe(p); // identical repeat, no mutation
    expect(p.cash('CAD').toString()).toBe(cash);
    expect(() => p.settleManualOrder(settleOp({ quantity: Money.fromString('0.20000000') }))).toThrow(/different payload/);
  });

  it('a SELL settles without a reservation and reduces the managed position', () => {
    let p = port('100000');
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.5'), PRICE, Money.zero());
    p = p.settleManualOrder(settleOp({ side: 'SELL', quantity: Money.fromString('0.5'), fee: Money.fromString('5.00') }));
    expect(p.position(BTC)).toBeNull();
    // proceeds = 0.5*40000 - 5 = 19995; cash = 100000 - 0 = ... starting cash after buy = 100000-20000=80000, +19995 = 99995.
    expect(p.cash('CAD').toString()).toBe('99995.00000000');
    expect(p.manualSettlement('manual-1')).not.toBeNull();
  });

  it('a SELL that exceeds the held position fails closed', () => {
    const p = port('100000');
    expect(() => p.settleManualOrder(settleOp({ side: 'SELL', quantity: Money.fromString('0.5') }))).toThrow(/SELL|held|short/);
  });

  it('a partial terminal fill consumes only the actual aggregate cost and refunds the leftover', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp({ quantity: Money.fromString('0.06250000') })); // half filled
    // cost = 0.0625*40000 + 10 = 2510.
    expect(p.cash('CAD').toString()).toBe('97490.00000000');
    expect(p.position(BTC)!.quantity.toString()).toBe('0.06250000');
    expect(p.orderReservation('manual-1')!.status).toBe('RELEASED');
    expect(p.reserved('CAD').isZero()).toBe(true); // full reservation freed (leftover refunded)
  });

  it('restart preserves manual settlement idempotency (re-settle after reload is a no-op)', () => {
    let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
    p = p.settleManualOrder(settleOp());
    // Simulate a restart: serialize -> deserialize.
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    expect(restored.manualSettlement('manual-1')).not.toBeNull();
    // Re-settling the identical payload after reload must NOT re-account.
    expect(restored.settleManualOrder(settleOp())).toBe(restored);
    expect(restored.cash('CAD').toString()).toBe(p.cash('CAD').toString());
    expect(restored.position(BTC)!.quantity.toString()).toBe(p.position(BTC)!.quantity.toString());
  });

  it('never routes through applyLiveFill', () => {
    let live = 0;
    const orig = Portfolio.prototype.applyLiveFill;
    Portfolio.prototype.applyLiveFill = function () {
      live += 1;
      throw new Error('applyLiveFill forbidden on manual path');
    };
    try {
      let p = port('100000').reserveOrder('manual-1', 'CAD', Money.fromString('5010.00'));
      p = p.settleManualOrder(settleOp());
      expect(live).toBe(0);
      expect(p.manualSettlement('manual-1')).not.toBeNull();
    } finally {
      Portfolio.prototype.applyLiveFill = orig;
    }
  });
});

describe('Gate 9 — fee-currency semantics', () => {
  /** Build a harness advanced to EVIDENCE_RECORDED; mutate the seeded fee. */
  async function settleWithFee(mutate?: (o: ReturnType<typeof exchangeOrder>) => void): Promise<{ out: Awaited<ReturnType<TestHarness['bridge']['settle']>>; h: TestHarness; intentId: string }> {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-fee${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: proposal.intent.quantity, averagePrice: PRICE, fee: Money.zero(), feeCurrency: 'quote' });
    const order = exchangeOrder({
      exchangeOrderId: '1',
      quantity: proposal.intent.quantity,
      filledQuantity: proposal.intent.quantity,
      averagePrice: PRICE,
      status: 'FILLED',
      side: 'BUY',
      symbol: BTC,
      fee: Money.fromString('10.00'),
      feeCurrency: 'quote',
    });
    mutate?.(order);
    h.seedOrder(order);
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    return { out, h, intentId };
  }

  it('an authoritative quote fee is used exactly for accounting', async () => {
    const { out, h } = await settleWithFee();
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const settlement = h.port.manualSettlement(h.intentStore.allIntents().keys().next().value!);
    expect(settlement!.settlementMode).toBe('exchange_validated');
    expect(settlement!.provenanceProof).toBe(false);
    // cost = 0.125*40000 + 10 = 5010 => cash = 94990.
    expect(h.port.cash('CAD').toString()).toBe('94990.00000000');
    h.cleanup();
  });

  it('a base-denominated authoritative fee fails closed (no safe conversion)', async () => {
    const { out, h } = await settleWithFee((o) => {
      o.feeCurrency = 'base';
    });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(out.reason).toMatch(/base-denominated/);
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    expect(h.port.position(BTC)).toBeNull();
    expect(h.port.orderReservation(h.intentStore.allIntents().keys().next().value!)!.status).toBe('ACTIVE');
    h.cleanup();
  });

  it('the absence of an authoritative fee fails closed (operator fee is never authoritative)', async () => {
    const { out, h } = await settleWithFee((o) => {
      o.fee = Money.zero();
    });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(out.reason).toMatch(/no authoritative quote-denominated fee/);
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    h.cleanup();
  });

  it('a negative authoritative fee fails closed', async () => {
    const { out, h } = await settleWithFee((o) => {
      o.fee = Money.fromString('-5.00');
    });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    h.cleanup();
  });

  it('a non-zero fee whose currency is UNKNOWN fails closed (the real NDAX order-status shape)', async () => {
    // Gate 9.3: NDAX GetOrderStatus does not expose a fee currency; `mapOrder`
    // now surfaces feeCurrency='unknown' with the raw amount. Accounting must
    // NEVER assume an unknown-currency fee is quote. Fails closed into
    // RECONCILIATION_REQUIRED, reservation stays reserved, nothing mutates.
    const { out, h, intentId } = await settleWithFee((o) => {
      o.feeCurrency = 'unknown';
    });
    expect(out.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(out.reason).toMatch(/not authoritatively quote/);
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    expect(h.port.position(BTC)).toBeNull();
    const reservation = h.port.orderReservation(intentId);
    expect(reservation).not.toBeNull();
    expect(reservation!.status).toBe('ACTIVE');
    h.cleanup();
  });

  it('a conflicting operator fee does not override the authoritative fee', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-fee${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    // operator reports an absurd fee; the authoritative exchange fee must win.
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: proposal.intent.quantity, averagePrice: PRICE, fee: Money.fromString('9999.00'), feeCurrency: 'quote' });
    h.seedOrder(exchangeOrder({ exchangeOrderId: '1', quantity: proposal.intent.quantity, filledQuantity: proposal.intent.quantity, averagePrice: PRICE, status: 'FILLED', side: 'BUY', symbol: BTC, fee: Money.fromString('10.00'), feeCurrency: 'quote' }));
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    // Authoritative fee 10 wins: cost = 5010, cash = 94990 (NOT 95499...).
    expect(h.port.cash('CAD').toString()).toBe('94990.00000000');
    expect(h.port.manualSettlement(intentId)!.fee.toString()).toBe('10.00000000');
    h.cleanup();
  });
});
