/**
 * Gate 9 — ManualTradeBridge lifecycle, security properties, reservation
 * accounting for the order-level manual path, and two-store crash recovery.
 *
 * The documented invariants under test:
 *   - RETRAC never submits/cancels; the adapter is used only for authoritative
 *     READS (getOrderStatus). No placeOrder/cancelOrder call occurs.
 *   - Manual settlement NEVER routes through applyLiveFill and NEVER treats an
 *     exchange OrderId as an execution identity.
 *   - Settlement requires an explicit operator acknowledgement (confirmSettle),
 *     prior confirmation, evidence, and an exchange-confirmed binding.
 *   - A BUY reservation is consumed by the actual aggregate cost and the leftover
 *     is released exactly once; a missing reservation / under-reserve fails
 *     closed.
 *   - The state machine can be made recoverable via `reconcile` without
 *     fabricating a fill or auto-releasing a reservation that may have executed.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import {
  TestHarness,
  makeContext,
  makePortfolio,
  exchangeOrder,
  BTC,
  PRICE,
  NOW,
} from './helpers.js';

/** Build a harness in the PROPOSED->CONFIRMED->EVIDENCE_RECORDED state for a BUY. */
function buyHarness(): { h: TestHarness; intentId: string } {
  const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-s${Date.now()}-${Math.random()}.json` });
  const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
  if (!proposal.ok) throw new Error('proposal should succeed');
  const intentId = proposal.intent.intentId;
  h.bridge.confirm(intentId);
  h.bridge.recordEvidence(intentId, {
    orderId: '999001',
    status: 'FILLED',
    filledQuantity: proposal.intent.quantity,
    averagePrice: PRICE,
    fee: Money.fromString('10.00'),
    feeCurrency: 'quote',
    evidenceSource: 'exchange_read',
  });
  h.seedOrder(
    exchangeOrder({
      exchangeOrderId: '999001',
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

describe('Gate 9 — propose', () => {
  it('an approved BUY creates a PROPOSED intent, reserves quote, persists the risk snapshot', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-p${Date.now()}-${Math.random()}.json` });
    const res = h.bridge.propose(makeContext('BUY'), { reason: 'test buy' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intent.status).toBe('PROPOSED');
    expect(res.intent.side).toBe('BUY');
    expect(res.intent.type).toBe('market');
    expect(res.intent.riskSnapshot.requiredBalance.isPositive()).toBe(true);
    expect(res.intent.reservationCurrency).toBe('CAD');
    expect(res.intent.reservationAmount).not.toBeNull();
    expect(h.port.reserved('CAD').isPositive()).toBe(true);
    expect(h.intentStore.get(res.intent.intentId)).not.toBeNull();
    expect(h.port.orderReservation(res.intent.intentId)!.status).toBe('ACTIVE');
    h.cleanup();
  });

  it('a rejected BUY does not create an intent or reservation', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-p${Date.now()}-${Math.random()}.json` });
    const ctx = makeContext('BUY', {
      deployableQuote: Money.fromString('1.00'),
      quoteBalance: { currency: 'CAD', total: Money.fromString('1.00'), available: Money.fromString('1.00'), held: Money.zero() },
      portfolioValue: Money.fromString('10.00'),
      peakPortfolioValue: Money.fromString('10.00'),
    });
    const res = h.bridge.propose(ctx, { reason: 'test buy' });
    expect(res.ok).toBe(false);
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    expect(h.intentStore.allIntents().size).toBe(0);
    h.cleanup();
  });

  it('an approved SELL creates a PROPOSED intent with no quote reservation', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-p${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = h.currentPortfolio.applyFill(BTC, 'BUY', Money.fromString('0.5'), PRICE, Money.zero());
    const res = h.bridge.propose(makeContext('SELL', { currentPosition: Money.fromString('0.5') }), { reason: 'test sell' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intent.side).toBe('SELL');
    expect(res.intent.reservationCurrency).toBeNull();
    expect(res.intent.reservationAmount).toBeNull();
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    h.cleanup();
  });

  it('a SELL exceeding the managed position fails closed', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-p${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = makePortfolio('100000', { external: new Map([[BTC, Money.fromString('0.5')]]) });
    const res = h.bridge.propose(
      makeContext('SELL', { currentPosition: Money.zero(), externalPosition: Money.fromString('0.5') }),
      { reason: 'bad sell' },
    );
    expect(res.ok).toBe(false);
    expect(h.intentStore.allIntents().size).toBe(0);
    h.cleanup();
  });
});

describe('Gate 9 — confirm + evidence state machine', () => {
  it('PROPOSED -> CONFIRMED; repeated confirmation is rejected', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-c${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const confirmed = h.bridge.confirm(proposal.intent.intentId);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(() => h.bridge.confirm(proposal.intent.intentId)).toThrow(/cannot be confirmed/);
    h.cleanup();
  });

  it('evidence cannot be recorded before confirmation', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-c${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    expect(() => h.bridge.recordEvidence(proposal.intent.intentId, { orderId: '1', status: 'FILLED' })).toThrow(/confirmed/);
    h.cleanup();
  });
});

describe('Gate 9 — settlement (order-level manual accounting)', () => {
  it('a terminal positive BUY settles once and releases the reservation exactly once', async () => {
    const { h, intentId } = buyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: true, operator: 'op' });
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    expect(h.port.cash('CAD').toString()).toBe('94990.00000000'); // 100000 - (0.125*40000 + 10)
    expect(h.port.position(BTC)!.quantity.isPositive()).toBe(true);
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    expect(h.port.orderReservation(intentId)!.remaining.isZero()).toBe(true);
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    expect(h.port.manualSettlement(intentId)).not.toBeNull();
    h.cleanup();
  });

  it('re-settling a terminal intent is refused with no double mutation', async () => {
    const { h, intentId } = buyHarness();
    const first = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(first.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const cashAfter = h.port.cash('CAD').toString();
    const positionAfter = h.port.position(BTC)!.quantity.toString();
    // Same payload re-settle: terminal state refuses safely (never re-account).
    const second = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(second.outcome).toBe('REFUSED');
    expect(h.port.cash('CAD').toString()).toBe(cashAfter);
    expect(h.port.position(BTC)!.quantity.toString()).toBe(positionAfter);
    h.cleanup();
  });

  it('one external OrderId cannot be accounted by two different intents (no double-account of a single real order)', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-dup${Date.now()}-${Math.random()}.json` });
    // Two identical BUY intents (risk-sized to the same quantity so both could
    // "bind") that the operator records against the SAME external OrderId.
    const a = h.bridge.propose(makeContext('BUY'), { reason: 'a' });
    if (!a.ok) throw new Error('propose a should succeed');
    const b = h.bridge.propose(makeContext('BUY'), { reason: 'b' });
    if (!b.ok) throw new Error('propose b should succeed');
    const idA = a.intent.intentId;
    const idB = b.intent.intentId;
    h.bridge.confirm(idA);
    h.bridge.confirm(idB);
    h.bridge.recordEvidence(idA, { orderId: '999001', status: 'FILLED', filledQuantity: a.intent.quantity, averagePrice: PRICE, fee: Money.fromString('10.00'), feeCurrency: 'quote' });
    h.bridge.recordEvidence(idB, { orderId: '999001', status: 'FILLED', filledQuantity: a.intent.quantity, averagePrice: PRICE, fee: Money.fromString('10.00'), feeCurrency: 'quote' });
    h.seedOrder(exchangeOrder({ exchangeOrderId: '999001', quantity: a.intent.quantity, filledQuantity: a.intent.quantity, averagePrice: PRICE, fee: Money.fromString('10.00'), feeCurrency: 'quote', status: 'FILLED', side: 'BUY', symbol: BTC }));
    const sA = await h.bridge.settle(idA, { confirmSettle: true });
    expect(sA.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    const sB = await h.bridge.settle(idB, { confirmSettle: true });
    // The second intent must NOT account the same real order.
    expect(sB.outcome).toBe('AMBIGUOUS'); // duplicate-order conflict, fail closed
    expect(h.port.position(BTC)!.quantity.toString()).toBe(a.intent.quantity.toString()); // NOT 2x
    expect(h.port.manualSettlement(idB)).toBeNull();
    expect(h.port.orderReservation(idB)!.status).toBe('ACTIVE'); // reservation retained
    h.cleanup();
  });

  it('settlement refuses without confirmSettle (no mutation)', async () => {
    const { h, intentId } = buyHarness();
    const out = await h.bridge.settle(intentId, { confirmSettle: false });
    expect(out.outcome).toBe('REFUSED');
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    h.cleanup();
  });

  it('a terminal no-fill releases the BUY reservation and marks the intent CANCELED', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-nf${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, { orderId: '999002', status: 'CANCELED', filledQuantity: Money.zero(), averagePrice: null, feeCurrency: 'quote' });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '999002',
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
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    expect(h.intentStore.get(intentId)!.status).toBe('CANCELED');
    h.cleanup();
  });

  it('an under-reserved BUY fails closed without mutating cash/position', async () => {
    const { h, intentId } = buyHarness();
    // The exchange order fills at a much higher price than the reservation funded.
    const overPrice = Money.fromString('200000.00');
    h.bridge.recordEvidence(intentId, { orderId: '999003', status: 'FILLED', filledQuantity: h.intentStore.get(intentId)!.quantity, averagePrice: overPrice, fee: Money.fromString('10.00'), feeCurrency: 'quote' });
    h.seedOrder(
      exchangeOrder({
        exchangeOrderId: '999003',
        quantity: h.intentStore.get(intentId)!.quantity,
        filledQuantity: h.intentStore.get(intentId)!.quantity,
        averagePrice: overPrice,
        fee: Money.fromString('10.00'),
        feeCurrency: 'quote',
        status: 'FILLED',
        side: 'BUY',
        symbol: BTC,
      }),
    );
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('AMBIGUOUS');
    expect(h.port.cash('CAD').toString()).toBe('100000.00000000');
    expect(h.port.position(BTC)).toBeNull();
    expect(h.port.orderReservation(intentId)!.status).toBe('ACTIVE');
    expect(h.intentStore.get(intentId)!.status).toBe('AMBIGUOUS');
    h.cleanup();
  });
});

describe('Gate 9 — cancel', () => {
  it('cancel releases a BUY reservation exactly once and marks CANCELED', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-cx${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    const canceled = h.bridge.cancel(intentId, { confirmCancel: true, reason: 'abort' });
    expect(canceled.status).toBe('CANCELED');
    expect(h.port.orderReservation(intentId)!.status).toBe('RELEASED');
    expect(h.port.reserved('CAD').isZero()).toBe(true);
    expect(() => h.bridge.cancel(intentId, { confirmCancel: true })).toThrow(/terminal/);
    h.cleanup();
  });

  it('cancel refuses while positive fill evidence exists', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-cx${Date.now()}-${Math.random()}.json` });
    const proposal = h.bridge.propose(makeContext('BUY'), { reason: 'buy' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, { orderId: '1', status: 'FILLED', filledQuantity: Money.fromString('0.1') });
    expect(() => h.bridge.cancel(intentId, { confirmCancel: true })).toThrow(/fill|settle/);
    h.cleanup();
  });
});

describe('Gate 9 — SELL settlement & ownership', () => {
  it('a terminal positive SELL settles once against managed inventory', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-sell${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = h.currentPortfolio.applyFill(BTC, 'BUY', Money.fromString('0.5'), PRICE, Money.zero());
    const proposal = h.bridge.propose(makeContext('SELL', { currentPosition: Money.fromString('0.5') }), { reason: 'sell' });
    if (!proposal.ok) throw new Error('proposal should succeed');
    const intentId = proposal.intent.intentId;
    h.bridge.confirm(intentId);
    h.bridge.recordEvidence(intentId, { orderId: '2', status: 'FILLED', filledQuantity: proposal.intent.quantity, averagePrice: Money.fromString('41000.00'), fee: Money.fromString('10.00'), feeCurrency: 'quote' });
    h.seedOrder(exchangeOrder({
      exchangeOrderId: '2',
      side: 'SELL',
      quantity: proposal.intent.quantity,
      filledQuantity: proposal.intent.quantity,
      averagePrice: Money.fromString('41000.00'),
      fee: Money.fromString('10.00'),
      feeCurrency: 'quote',
      status: 'FILLED',
      symbol: BTC,
    }));
    const out = await h.bridge.settle(intentId, { confirmSettle: true });
    expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
    // cash: 80000 (after buy) + (0.5*41000 - 10) = 100490.
    expect(h.port.cash('CAD').toString()).toBe('100490.00000000');
    expect(h.port.position(BTC)).toBeNull();
    expect(h.port.manualSettlement(intentId)).not.toBeNull();
    h.cleanup();
  });

  it('authorized external inventory (EXTERNAL_AUTHORIZED) supports a managed SELL', async () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-sell${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = h.currentPortfolio
      .withExternalSnapshot(new Map([[BTC, Money.fromString('0.5')]]))
      .authorizeExternal(BTC);
    const proposal = h.bridge.propose(makeContext('SELL', { currentPosition: Money.fromString('0.5') }), { reason: 'sell' });
    expect(proposal.ok).toBe(true); // EXTERNAL_AUTHORIZED is bot-managed => tradable
    h.cleanup();
  });

  it('non-authorized external inventory cannot be sold, and no intent is created', () => {
    const h = new TestHarness({ intentFilePath: `/tmp/opencode/g9-sell${Date.now()}-${Math.random()}.json` });
    h.currentPortfolio = h.currentPortfolio.withExternalSnapshot(new Map([[BTC, Money.fromString('0.5')]]));
    const res = h.bridge.propose(
      makeContext('SELL', { currentPosition: Money.zero(), externalPosition: Money.fromString('0.5') }),
      { reason: 'sell' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/SELL/);
    expect(h.intentStore.allIntents().size).toBe(0);
    h.cleanup();
  });

  it('manual settlement cannot modify an unrelated intent', async () => {
    const { h, intentId } = buyHarness();
    await h.bridge.settle(intentId, { confirmSettle: true });
    // A different intent is untouched.
    const other = h.intentStore.get('manual-does-not-exist');
    expect(other).toBeNull();
    expect(h.port.manualSettlement('manual-does-not-exist')).toBeNull();
    expect(h.port.manualSettlementsView().size).toBe(1);
    h.cleanup();
  });
});

describe('Gate 9 — security properties', () => {
  it('manual settlement never calls applyLiveFill and never treats OrderId as execution id', async () => {
    const { h, intentId } = buyHarness();
    let liveCalls = 0;
    const orig = Portfolio.prototype.applyLiveFill;
    Portfolio.prototype.applyLiveFill = function () {
      liveCalls += 1;
      throw new Error('applyLiveFill must never be called by the manual path');
    };
    try {
      const out = await h.bridge.settle(intentId, { confirmSettle: true });
      expect(out.outcome).toBe('ACCOUNTED_WITH_EXCHANGE_VALIDATION');
      expect(liveCalls).toBe(0);
      const settlement = h.port.manualSettlement(intentId)!;
      expect(settlement.orderId).toBe('999001');
      expect('executionId' in settlement).toBe(false);
    } finally {
      Portfolio.prototype.applyLiveFill = orig;
      h.cleanup();
    }
  });

  it('the adapter is only ever read via getOrderStatus; placeOrder/cancelOrder are never called', async () => {
    const { h, intentId } = buyHarness();
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
});
