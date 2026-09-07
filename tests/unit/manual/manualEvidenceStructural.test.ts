/**
 * Gate 9 — structural evidence validation + terminal-state machine.
 *
 * `validateEvidenceStructural` decides on the OPERATOR-recorded evidence alone
 * (before any exchange read): open/partial stays PENDING, a terminal no-fill is
 * TERMINAL_NO_FILL, a terminal positive fill is SETTLABLE only when well-formed,
 * and an impossible fill is INVALID. `evidenceProgressConflict` rejects
 * regression/conflicting terminal records and is idempotent for repeats.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { validateEvidenceStructural, evidenceProgressConflict } from '../../../src/manual/index.js';
import type { ManualEvidence, ManualTradeIntent } from '../../../src/manual/index.js';

const QTY = Money.fromString('0.12500000');

function intent(over: Partial<ManualTradeIntent> = {}): ManualTradeIntent {
  return {
    intentId: 'i',
    status: 'EVIDENCE_RECORDED',
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    quantity: QTY,
    limitPrice: null,
    tif: null,
    reason: 't',
    riskSnapshot: {} as never,
    evidence: null,
    operatorConfirmedBy: 'op',
    createdAtMs: 1,
    updatedAtMs: 1,
    events: [],
    reservationCurrency: 'CAD',
    reservationAmount: Money.fromString('5010.00'),
    ...over,
  };
}

function ev(over: Partial<ManualEvidence> = {}): ManualEvidence {
  return {
    orderId: '999001',
    status: 'FILLED',
    filledQuantity: QTY,
    averagePrice: Money.fromString('40000.00'),
    fee: Money.fromString('10.00'),
    feeCurrency: 'quote',
    evidenceSource: 'exchange_read',
    recordedAtMs: 1,
    ...over,
  };
}

describe('Gate 9 — structural validation', () => {
  it('open order evidence is PENDING (may still fill)', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'OPEN', filledQuantity: null, averagePrice: null }));
    expect(r.ok).toBe(true);
    expect(r.disposition).toBe('PENDING');
  });

  it('partial order evidence is PENDING', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'PARTIALLY_FILLED', filledQuantity: Money.fromString('0.01'), averagePrice: Money.fromString('40000.00') }));
    expect(r.ok).toBe(true);
    expect(r.disposition).toBe('PENDING');
  });

  it('terminal no status is PENDING (cannot decide)', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: null, filledQuantity: null, averagePrice: null }));
    expect(r.disposition).toBe('PENDING');
  });

  it('terminal no-fill is TERMINAL_NO_FILL', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'CANCELED', filledQuantity: Money.zero(), averagePrice: null }));
    expect(r.disposition).toBe('TERMINAL_NO_FILL');
  });

  it('terminal positive fill is SETTLABLE', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'FILLED' }));
    expect(r.ok).toBe(true);
    expect(r.disposition).toBe('SETTLABLE');
  });

  it('an overfill (filled > proposed) is INVALID', () => {
    const r = validateEvidenceStructural(intent(), ev({ filledQuantity: Money.fromString('0.20000000') }));
    expect(r.ok).toBe(false);
    expect(r.disposition).toBe('INVALID');
  });

  it('a terminal positive fill without a positive average price is INVALID', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'FILLED', averagePrice: null }));
    expect(r.ok).toBe(false);
    expect(r.disposition).toBe('INVALID');
  });

  it('a negative fee is INVALID', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'FILLED', fee: Money.fromString('-1.00') }));
    expect(r.ok).toBe(false);
    expect(r.disposition).toBe('INVALID');
  });

  it('a negative filled quantity is INVALID', () => {
    const r = validateEvidenceStructural(intent(), ev({ status: 'FILLED', filledQuantity: Money.fromString('-0.1') }));
    expect(r.ok).toBe(false);
    expect(r.disposition).toBe('INVALID');
  });

  it('a non-numeric OrderId is INVALID', () => {
    const r = validateEvidenceStructural(intent(), ev({ orderId: 'not-a-number', status: 'FILLED' }));
    expect(r.ok).toBe(false);
    expect(r.disposition).toBe('INVALID');
  });
});

describe('Gate 9 — evidence progress conflict (terminal can never regress)', () => {
  it('terminal -> open regression is a conflict', () => {
    const prev = ev({ status: 'FILLED' });
    const next = ev({ status: 'OPEN', filledQuantity: null, averagePrice: null, orderId: '2' });
    expect(evidenceProgressConflict(prev, next)).toMatch(/conflict/);
  });

  it('conflicting terminal states are a conflict', () => {
    const prev = ev({ status: 'FILLED', filledQuantity: Money.fromString('0.12500000') });
    const next = ev({ status: 'CANCELED', filledQuantity: Money.zero(), averagePrice: null, orderId: '2' });
    expect(evidenceProgressConflict(prev, next)).toMatch(/conflict/);
  });

  it('a repeat identical terminal record is harmless (no conflict)', () => {
    const prev = ev({ status: 'FILLED' });
    const next = ev({ status: 'FILLED' });
    expect(evidenceProgressConflict(prev, next)).toBeNull();
  });

  it('a confirmed no-fill followed by a different terminal state is a conflict', () => {
    const prev = ev({ status: 'CANCELED', filledQuantity: Money.zero() });
    const next = ev({ status: 'FILLED' });
    expect(evidenceProgressConflict(prev, next)).toMatch(/conflict/);
  });

  it('non-terminal -> non-terminal update is allowed', () => {
    const prev = ev({ status: 'PARTIALLY_FILLED', filledQuantity: Money.fromString('0.01'), averagePrice: Money.fromString('40000.00') });
    const next = ev({ status: 'PARTIALLY_FILLED', filledQuantity: Money.fromString('0.05'), averagePrice: Money.fromString('40000.00'), orderId: '2' });
    expect(evidenceProgressConflict(prev, next)).toBeNull();
  });
});
