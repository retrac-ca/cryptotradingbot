/**
 * P2-1 — action-aware pre-trade gate projection.
 *
 * These tests exercise the PURE `livePreTradeGate` against the real V1
 * `ReconciliationResult` type. They prove the action-aware semantics:
 *   - a SELL is allowed despite external/unmanaged quote (CAD) drift and
 *     unrelated-asset drift, but blocked on the sold base asset;
 *   - all global unresolved findings (orders/executions/reservations/operator/
 *     cross-domain/read-failure/HALTED) block;
 *   - a BUY never treats the exchange quote total as managed cash.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { livePreTradeGate } from '../../../src/reconcile/index.js';
import type {
  BalanceFinding,
  ExecutionFinding,
  OperatorFinding,
  OrderFinding,
  ReconciliationResult,
  ReservationFinding,
} from '../../../src/reconcile/index.js';

const QUOTES = new Set(['CAD']);

function baseResult(over: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    status: 'READY',
    reasons: [],
    readFailures: [],
    orderFindings: [],
    executionFindings: [],
    reservationFindings: [],
    balanceFindings: [],
    operatorFindings: [],
    commitCandidates: [],
    reservationReleases: [],
    canCommit: false,
    ...over,
  };
}

function balance(currency: string, mismatch = true): BalanceFinding {
  return {
    currency,
    expected: mismatch ? Money.fromString('1') : null,
    observed: mismatch ? Money.fromString('2') : null,
    mismatch,
    reason: mismatch ? `${currency} mismatch` : `${currency} ok`,
  };
}

function order(over: Partial<OrderFinding> = {}): OrderFinding {
  return {
    clientOrderId: 'live-BTCCAD-x',
    exchangeOrderId: null,
    localStatus: 'UNKNOWN',
    exchangeStatus: null,
    disposition: 'AMBIGUOUS',
    executedQuantity: Money.zero(),
    provenExecutedQuantity: Money.zero(),
    completeness: 'UNKNOWN',
    reason: 'test',
    ...over,
  };
}

function execution(over: Partial<ExecutionFinding> = {}): ExecutionFinding {
  return {
    executionId: 'e1',
    orderId: '999',
    symbol: 'BTC/CAD',
    side: 'BUY',
    quantity: Money.fromString('0.1'),
    price: Money.fromString('40000'),
    fee: Money.zero(),
    feeProductId: null,
    feeDisposition: 'QUOTE',
    correlation: 'UNCORRELATED',
    matchedClientOrderId: null,
    completeness: 'UNKNOWN',
    reason: 'test',
    ...over,
  };
}

function reservation(over: Partial<ReservationFinding> = {}): ReservationFinding {
  return { orderId: 'live-BTCCAD-x', disposition: 'AMBIGUOUS', reason: 'test', ...over };
}

function operator(over: Partial<OperatorFinding> = {}): OperatorFinding {
  return { kind: 'OPERATOR_REQUIRED_AMBIGUOUS_ORDER', detail: 'test', ...over };
}

const SELL = { side: 'SELL' as const, symbol: 'BTC/CAD', quoteCurrencies: QUOTES };
const BUY = { side: 'BUY' as const, symbol: 'BTC/CAD', quoteCurrencies: QUOTES };

describe('P2-1 livePreTradeGate — balance rules (action-aware)', () => {
  it('1. SELL allowed despite external/unmanaged quote (CAD) mismatch', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      balanceFindings: [balance('CAD')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('2. SELL allowed despite unrelated external asset drift (sold base unaffected)', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      balanceFindings: [balance('ETH'), balance('SHIB')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
  });

  it('3. SELL blocked when the sold base asset has a balance mismatch', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      balanceFindings: [balance('BTC')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/sold base BTC/);
  });

  it('SELL ignores a quote mismatch but still blocks on a simultaneous base mismatch', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      balanceFindings: [balance('CAD'), balance('BTC')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/sold base BTC/);
    expect(gate.blockers.join(' ')).not.toMatch(/CAD/);
  });
});

describe('P2-1 livePreTradeGate — global hard blocks', () => {
  it('4/5/6. SELL blocked on an unresolved CREATED / SUBMITTED / UNKNOWN order', () => {
    for (const status of ['CREATED', 'SUBMITTED', 'UNKNOWN'] as const) {
      const result = baseResult({ orderFindings: [order({ localStatus: status })] });
      const gate = livePreTradeGate(result, SELL);
      expect(gate.allowed).toBe(false);
      expect(gate.blockers.join(' ')).toMatch(new RegExp(status));
    }
  });

  it('7. SELL blocked on FILLED order evidence that is not proven/attested', () => {
    const result = baseResult({
      orderFindings: [
        order({ localStatus: 'FILLED', exchangeStatus: 'FILLED', disposition: 'OPERATOR_REQUIRED', completeness: 'INCOMPLETE' }),
      ],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/not confirmed/);
  });

  it('SELL allowed when order is CONFIRMED (including operator-attested FILLED)', () => {
    const result = baseResult({
      orderFindings: [
        order({ localStatus: 'FILLED', exchangeStatus: 'FILLED', disposition: 'CONFIRMED', completeness: 'COMPLETE' }),
      ],
    });
    expect(livePreTradeGate(result, SELL).allowed).toBe(true);
  });

  it('8. SELL is NOT blocked by an UNCORRELATED execution (attribution-scoping)', () => {
    const result = baseResult({ executionFindings: [execution({ correlation: 'UNCORRELATED' })] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('SELL blocked on a PROVEN execution with a non-quote fee', () => {
    for (const feeDisposition of ['BASE', 'UNKNOWN', 'MALFORMED'] as const) {
      const result = baseResult({ executionFindings: [execution({ correlation: 'PROVEN', feeDisposition })] });
      const gate = livePreTradeGate(result, SELL);
      expect(gate.allowed).toBe(false);
      expect(gate.blockers.join(' ')).toMatch(/not proven\+quote/);
    }
  });

  it('9. SELL blocked on an ambiguous reservation', () => {
    const result = baseResult({ reservationFindings: [reservation()] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/reservation .* ambiguous/);
  });

  it('10. SELL blocked on an operator finding', () => {
    const result = baseResult({ operatorFindings: [operator()] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/operator finding/);
  });

  it('11. SELL blocked on a cross-domain safety finding (represented as an operator finding)', () => {
    const result = baseResult({
      operatorFindings: [operator({ detail: 'reservation r1 has no owning order/intent (orphan) — never release' })],
    });
    expect(livePreTradeGate(result, SELL).allowed).toBe(false);
  });

  it('12. SELL blocked on a read failure', () => {
    const result = baseResult({ readFailures: ['getBalances failed: network'] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/read failure/);
  });

  it('13. SELL blocked on HALTED', () => {
    const result = baseResult({ status: 'HALTED', reasons: ['state-directory mutation lock is held'] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/HALTED/);
  });
});

describe('P2-1 livePreTradeGate — BUY semantics (not reachable; must stay safe)', () => {
  it('14. BUY never treats the exchange quote total as managed cash', () => {
    // Managed CAD 11.97 vs exchange CAD 37.99 -> quote mismatch. No managed
    // deployable supplied -> must block.
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      balanceFindings: [balance('CAD')],
    });
    const gate = livePreTradeGate(result, BUY);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/BUY quote CAD/);
    expect(gate.blockers.join(' ')).toMatch(/MANAGED deployable quote/);
  });

  it('15. BUY quote mismatch blocks even with positive managed deployable', () => {
    const result = baseResult({ balanceFindings: [balance('CAD')] });
    const gate = livePreTradeGate(result, { ...BUY, managedQuoteDeployable: Money.fromString('100') });
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/BUY quote CAD/);
  });

  it('BUY with a reconciled quote and positive managed deployable is allowed', () => {
    const result = baseResult({ balanceFindings: [balance('CAD', false)] });
    const gate = livePreTradeGate(result, { ...BUY, managedQuoteDeployable: Money.fromString('100') });
    expect(gate.allowed).toBe(true);
  });

  it('BUY with zero managed deployable blocks', () => {
    const result = baseResult();
    const gate = livePreTradeGate(result, BUY);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/MANAGED deployable quote/);
  });
});

describe('P2-1 execution attribution scope — SELL vs BUY', () => {
  /** One external/unmanaged historical execution (no local order attribution). */
  function externalExecution(i: number, over: Partial<ExecutionFinding> = {}): ExecutionFinding {
    const symbols = ['BTC/CAD', 'ETH/CAD', 'ADA/CAD', 'DOT/CAD', 'SHIB/CAD', 'ATOM/CAD'];
    const fees: ExecutionFinding['feeDisposition'][] = ['QUOTE', 'BASE', 'UNKNOWN'];
    return execution({
      executionId: `ext-${i}`,
      orderId: `9000000${i}`,
      symbol: symbols[i % symbols.length]!,
      side: i % 3 === 0 ? 'BUY' : 'SELL',
      correlation: 'UNCORRELATED',
      matchedClientOrderId: null,
      feeDisposition: fees[i % fees.length]!,
      ...over,
    });
  }

  it('1. SELL with an UNCORRELATED execution is allowed when all else passes', () => {
    const result = baseResult({ executionFindings: [execution({ correlation: 'UNCORRELATED' })] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
    expect(gate.blockers.join(' ')).not.toMatch(/not proven\+quote/);
  });

  it('2. realistic 33 UNCORRELATED + 1 PROVEN/QUOTE bot execution allows the SELL', () => {
    const bot = execution({
      executionId: '25437609',
      orderId: '26177556994',
      symbol: 'BTC/CAD',
      side: 'SELL',
      correlation: 'PROVEN',
      feeDisposition: 'QUOTE',
      matchedClientOrderId: 'live-BTCCAD-287fdb4f-c1cf-486c-a049-cac2dbd4da44',
    });
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      executionFindings: [bot, ...Array.from({ length: 33 }, (_, i) => externalExecution(i))],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('3. SELL blocked on an AMBIGUOUS execution', () => {
    const result = baseResult({ executionFindings: [execution({ correlation: 'AMBIGUOUS' })] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/AMBIGUOUS/);
  });

  it('4. SELL blocked on a STRONG_BUT_NOT_PROVEN execution (defensive)', () => {
    const result = baseResult({ executionFindings: [execution({ correlation: 'STRONG_BUT_NOT_PROVEN' })] });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/not proven\+quote/);
  });

  it('5/6. SELL blocked on a PROVEN execution with BASE or UNKNOWN fee', () => {
    for (const feeDisposition of ['BASE', 'UNKNOWN'] as const) {
      const result = baseResult({ executionFindings: [execution({ correlation: 'PROVEN', feeDisposition })] });
      expect(livePreTradeGate(result, SELL).allowed).toBe(false);
    }
  });

  it('7. UNCORRELATED executions do NOT bypass the sold-base balance protection', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      executionFindings: [externalExecution(0), externalExecution(1)],
      balanceFindings: [balance('BTC')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/sold base BTC/);
  });

  it('8. UNCORRELATED + external CAD mismatch + unrelated assets allow the SELL', () => {
    const result = baseResult({
      status: 'RECONCILIATION_REQUIRED',
      executionFindings: [externalExecution(0), externalExecution(1), externalExecution(2)],
      balanceFindings: [balance('CAD'), balance('ETH'), balance('SHIB')],
    });
    const gate = livePreTradeGate(result, SELL);
    expect(gate.allowed).toBe(true);
    expect(gate.blockers).toEqual([]);
  });

  it('9. BUY remains conservative: an UNCORRELATED execution still blocks', () => {
    const result = baseResult({ executionFindings: [execution({ correlation: 'UNCORRELATED' })] });
    const gate = livePreTradeGate(result, BUY);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/not proven\+quote/);
  });

  it('11. an UNCORRELATED execution with an unsafe fee does not block, but PROVEN does', () => {
    for (const feeDisposition of ['BASE', 'UNKNOWN', 'MALFORMED'] as const) {
      const uncorrelated = baseResult({ executionFindings: [execution({ correlation: 'UNCORRELATED', feeDisposition })] });
      expect(livePreTradeGate(uncorrelated, SELL).allowed).toBe(true);

      const proven = baseResult({ executionFindings: [execution({ correlation: 'PROVEN', feeDisposition })] });
      expect(livePreTradeGate(proven, SELL).allowed).toBe(false);
    }
  });

  it('12. livePreTradeGate is pure: it does not mutate the reconciliation result', () => {
    const finding = execution({ correlation: 'UNCORRELATED' });
    const orderFinding = order({ disposition: 'AMBIGUOUS' });
    const result = baseResult({ executionFindings: [finding], orderFindings: [orderFinding] });
    const execRef = result.executionFindings;
    const orderRef = result.orderFindings;

    const gate = livePreTradeGate(result, SELL);

    expect(gate.allowed).toBe(false);
    expect(result.executionFindings).toBe(execRef);
    expect(result.orderFindings).toBe(orderRef);
    expect(result.executionFindings).toEqual([finding]);
    expect(result.orderFindings).toEqual([orderFinding]);
    expect(Object.prototype.hasOwnProperty.call(result, 'blockers')).toBe(false);
  });
});
