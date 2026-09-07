/**
 * Gate 9 — exchange validation + OrderId→intent binding.
 *
 * `validateEvidenceAgainstExchange` must NEVER accept a merely "related-looking"
 * exchange order. An operator-supplied OrderId is not proof of ownership; the
 * authoritative read must (a) be terminal, (b) agree with the operator evidence,
 * and (c) BIND to the intent via the strongest actually-supported authoritative
 * fields (requested quantity, creation-time-relative-to-proposal, limit spec).
 * Any insufficiency fails closed.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { validateEvidenceAgainstExchange } from '../../../src/manual/index.js';
import type { ManualEvidence, ManualTradeIntent } from '../../../src/manual/index.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { exchangeOrder, BTC, NOW } from './helpers.js';

const QTY = Money.fromString('0.12500000');

function makeIntent(over: Partial<ManualTradeIntent> = {}): ManualTradeIntent {
  return {
    intentId: 'manual-intent-1',
    status: 'EVIDENCE_RECORDED',
    symbol: BTC,
    side: 'BUY',
    type: 'market',
    quantity: QTY,
    limitPrice: null,
    tif: null,
    reason: 'test',
    riskSnapshot: {
      symbol: BTC,
      side: 'BUY',
      type: 'market',
      referencePrice: Money.fromString('40000.00'),
      estimatedNotional: Money.fromString('5000.00'),
      estimatedFee: Money.fromString('10.00'),
      quoteCurrency: 'CAD',
      requiredBalance: Money.fromString('5010.00'),
      deployableQuoteAtProposal: Money.fromString('100000.00'),
      portfolioValueAtProposal: Money.fromString('50000.00'),
      peakPortfolioValueAtProposal: Money.fromString('50000.00'),
      portfolioExposureAtProposal: Money.zero(),
      currentPositionAtProposal: Money.zero(),
      openManagedPositionCountAtProposal: 0,
      appliedLimits: {
        maxTradeAmount: Money.zero(),
        maxPositionSizeFraction: 0.1,
        maxPortfolioExposureFraction: 0.5,
        maxDailyLossFraction: 0.05,
        maxDrawdownFraction: 0.1,
        cooldownAfterLossMs: 0,
        maxOpenPositions: 5,
        killSwitchActive: false,
      },
      marketDataTimestampMs: NOW,
      marketDataObservedAtMs: NOW,
      proposalTimeMs: NOW,
    },
    evidence: null,
    operatorConfirmedBy: 'op',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    events: [],
    reservationCurrency: 'CAD',
    reservationAmount: Money.fromString('5010.00'),
    ...over,
  };
}

function makeEvidence(over: Partial<ManualEvidence> = {}): ManualEvidence {
  return {
    orderId: '999001',
    status: 'FILLED',
    filledQuantity: QTY,
    averagePrice: Money.fromString('40000.00'),
    fee: Money.fromString('10.00'),
    feeCurrency: 'quote',
    evidenceSource: 'exchange_read',
    recordedAtMs: NOW,
    ...over,
  };
}

function adapterSeededWith(order: ReturnType<typeof exchangeOrder>): FakeExchange {
  const fx = new FakeExchange();
  fx.seedOrders([order]);
  return fx;
}

async function validateWith(order: ReturnType<typeof exchangeOrder>, intent?: ManualTradeIntent, evidence?: ManualEvidence) {
  return validateEvidenceAgainstExchange(adapterSeededWith(order), intent ?? makeIntent(), evidence ?? makeEvidence());
}

describe('Gate 9 — exchange validation: fail-closed results', () => {
  it('a consistent order passes (requested quantity + creation time) but is NOT provenance proof', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW, side: 'BUY', symbol: BTC }),
    );
    expect(v.ok).toBe(true);
    expect(v.authoritative).toBeDefined();
    expect(v.binding).toContain('requestedQuantity');
    // CONSISTENCY validation only — never provenance proof.
    expect(v.provenanceProof).toBe(false);
  });

  it('a same-symbol/same-side/same-quantity/same-price order with a post-proposal timestamp is still only consistency, never proof', async () => {
    // This is the adversarial "unrelated but looks identical" case: the order is
    // internally consistent with the intent, but it can STILL be an unrelated
    // order. Consistency must never be conflated with provenance proof.
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW + 1_000, side: 'BUY', symbol: BTC, type: 'market' }),
    );
    expect(v.ok).toBe(true);
    expect(v.provenanceProof).toBe(false);
    expect(v.binding!.length).toBeGreaterThan(0);
  });

  it('an exchange read failure fails closed', async () => {
    const fx = new FakeExchange();
    fx.setFailures({ getOrderStatus: { kind: 'network' } });
    const v = await validateEvidenceAgainstExchange(fx, makeIntent(), makeEvidence());
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/read failed/);
  });

  it('a non-terminal exchange order is PENDING (kept reserved), not attributed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: Money.fromString('0.01'), status: 'OPEN', createdAtMs: NOW }),
    );
    expect(v.pending).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.authoritative).toBeUndefined();
  });

  it('wrong symbol fails closed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', symbol: 'ETH/CAD', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/ETH\/CAD|symbol/);
  });

  it('wrong side fails closed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', side: 'SELL', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/expected BUY/);
  });

  it('wrong requested quantity (an unrelated same-symbol/same-side order) fails closed', async () => {
    // The order requested a different size; the operator-typed evidence agrees
    // with the exchange fill, but the order is NOT the one the intent proposed.
    const wrongQty = Money.fromString('0.20000000');
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: wrongQty, filledQuantity: wrongQty, status: 'FILLED', createdAtMs: NOW }),
      makeIntent(),
      makeEvidence({ filledQuantity: wrongQty, averagePrice: Money.fromString('40000.00') }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/requested quantity/);
  });

  it('an order predating the proposal (temporal) is rejected as unrelated', async () => {
    // The exchange order was created BEFORE the intent was proposed.
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW - 5_000 }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/before the intent|unrelated|predat/);
  });

  it('wrong order type for a limit intent fails closed', async () => {
    const limitIntent = makeIntent({ type: 'limit', limitPrice: Money.fromString('40000.00') });
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', type: 'market', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW }),
      limitIntent,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/limit/);
  });

  it('wrong limit price for a limit intent fails closed', async () => {
    const limitIntent = makeIntent({ type: 'limit', limitPrice: Money.fromString('40000.00') });
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', type: 'limit', price: Money.fromString('39999.00'), quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW }),
      limitIntent,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/limit price/);
  });

  it('insufficient binding information fails closed (no strong factor)', async () => {
    // No requested quantity (0), no creation time, market intent with no limit.
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: Money.zero(), filledQuantity: QTY, status: 'FILLED', createdAtMs: null, type: 'market' }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/insufficient authoritative data/);
  });

  it('an over-fill beyond the order request fails closed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: Money.fromString('0.20000000'), status: 'FILLED', createdAtMs: NOW }),
      makeIntent(),
      makeEvidence({ filledQuantity: Money.fromString('0.20000000') }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/exceeds its own requested/);
  });

  it('operator/exchange fill-quantity mismatch fails closed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: QTY, status: 'FILLED', createdAtMs: NOW }),
      makeIntent(),
      makeEvidence({ filledQuantity: Money.fromString('0.12400000') }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/filled/);
  });

  it('operator/exchange average-price mismatch fails closed', async () => {
    const v = await validateWith(
      exchangeOrder({ exchangeOrderId: '999001', quantity: QTY, filledQuantity: QTY, averagePrice: Money.fromString('40000.00'), status: 'FILLED', createdAtMs: NOW }),
      makeIntent(),
      makeEvidence({ averagePrice: Money.fromString('41000.00') }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/avg-price/);
  });
});
