/**
 * Reconciliation V1 — correlation, completeness, fees, orders, reservations,
 * balances, cross-domain, and the read-only reconcile() / commitProven() split.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { OrderStore, ManagedStateStore } from '../../../src/persistence/index.js';
import { ManualIntentStore } from '../../../src/manual/index.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';
import { correlateExecution } from '../../../src/reconcile/index.js';
import { analyzeCompleteness } from '../../../src/reconcile/index.js';
import { resolveFeeDisposition } from '../../../src/reconcile/index.js';
import { classifyOrder } from '../../../src/reconcile/index.js';
import { reservationDisposition } from '../../../src/reconcile/index.js';
import { reconcileBalances } from '../../../src/reconcile/index.js';
import { crossDomainValidation } from '../../../src/reconcile/index.js';
import { reconcile, commitProven, type ReconciliationDeps } from '../../../src/reconcile/index.js';
import type { Order } from '../../../src/order.js';
import type { AccountTrade, MarketInfo } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';
const PRICE = Money.fromString('40000');
const QTY = Money.fromString('0.1');
const FEE = Money.fromString('4.00');

function order(clientOrderId: string, status: Order['status'], exchangeOrderId: string | null): Order {
  return {
    clientOrderId,
    exchangeOrderId,
    symbol: SYMBOL,
    side: 'BUY',
    type: 'market',
    status,
    quantity: QTY,
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function trade(executionId: string, orderId: string, quantity: Money = QTY, fee: Money = FEE, feeProductId: string | null = 'quote-id', side: 'BUY' | 'SELL' = 'BUY'): AccountTrade {
  return {
    executionId,
    tradeId: `t-${executionId}`,
    orderId,
    clientOrderId: '0',
    symbol: SYMBOL,
    instrumentId: '1',
    accountId: '1',
    subAccountId: '0',
    side,
    quantity,
    remainingQuantity: Money.zero(),
    price: PRICE,
    value: quantity.mul(PRICE),
    tradeTimeMs: 1,
    fee,
    feeProductId,
    orderOriginator: null,
  };
}

const market: MarketInfo = {
  symbol: SYMBOL,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 8,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0.0001'),
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  baseProductId: 'base-id',
  quoteProductId: 'quote-id',
  baseProductSymbol: 'BTC',
  quoteProductSymbol: 'CAD',
};

describe('Reconciliation V1 — execution correlation', () => {
  it('exact OrderId match + symbol + side => PROVEN', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution(trade('e1', '999001'), orders);
    expect(r.correlation).toBe('PROVEN');
    expect(r.matchedClientOrderId).toBe('local-1');
  });

  it('numeric OrderId normalization (leading zero) => PROVEN', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution(trade('e1', '0999001'), orders);
    expect(r.correlation).toBe('PROVEN');
  });

  it('mismatched OrderId => UNCORRELATED', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution(trade('e1', '999002'), orders);
    expect(r.correlation).toBe('UNCORRELATED');
  });

  it('multiple local orders with the same OrderId => AMBIGUOUS', () => {
    const orders = new Map([
      ['local-1', order('local-1', 'OPEN', '999001')],
      ['local-2', order('local-2', 'OPEN', '999001')],
    ]);
    const r = correlateExecution(trade('e1', '999001'), orders);
    expect(r.correlation).toBe('AMBIGUOUS');
  });

  it('clientOrderId-only is never PROVEN', () => {
    const orders = new Map([['local-1', { ...order('local-1', 'OPEN', null), clientOrderId: 'local-1' }]]);
    const t = { ...trade('e1', '999001'), orderId: null, clientOrderId: 'local-1' };
    const r = correlateExecution(t, orders);
    expect(r.correlation).toBe('AMBIGUOUS'); // missing exchange OrderId
  });

  it('symbol mismatch => not PROVEN', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution({ ...trade('e1', '999001'), symbol: 'ETH/CAD' }, orders);
    expect(r.correlation).not.toBe('PROVEN');
  });

  it('side mismatch => not PROVEN', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution(trade('e1', '999001', QTY, FEE, 'quote-id', 'SELL'), orders);
    expect(r.correlation).not.toBe('PROVEN');
  });

  it('missing executionId => not PROVEN', () => {
    const orders = new Map([['local-1', order('local-1', 'OPEN', '999001')]]);
    const r = correlateExecution({ ...trade('e1', '999001'), executionId: null }, orders);
    expect(r.correlation).toBe('AMBIGUOUS');
  });
});

describe('Reconciliation V1 — completeness', () => {
  it('no fill => COMPLETE (nothing to enumerate)', () => {
    expect(analyzeCompleteness(Money.zero(), Money.zero())).toBe('COMPLETE');
  });
  it('proven > 0 with zero executed => INCOMPLETE (never COMPLETE)', () => {
    expect(analyzeCompleteness(Money.zero(), Money.fromString('0.05'))).toBe('INCOMPLETE');
  });
  it('proven > 0 with negative executed => INCOMPLETE (never COMPLETE)', () => {
    expect(analyzeCompleteness(Money.fromString('-1'), Money.fromString('0.05'))).toBe('INCOMPLETE');
  });
  it('proven < executed => INCOMPLETE', () => {
    expect(analyzeCompleteness(QTY, Money.fromString('0.05'))).toBe('INCOMPLETE');
  });
  it('proven > executed => INCOMPLETE (contradiction)', () => {
    expect(analyzeCompleteness(Money.fromString('0.05'), QTY)).toBe('INCOMPLETE');
  });
  it('matching quantity but enumeration not proven => UNKNOWN (NDAX)', () => {
    expect(analyzeCompleteness(QTY, QTY)).toBe('UNKNOWN');
  });
  it('missing executed quantity => UNKNOWN', () => {
    expect(analyzeCompleteness(null, QTY)).toBe('UNKNOWN');
  });
});

describe('Reconciliation V1 — fee disposition', () => {
  it('zero fee => QUOTE', () => expect(resolveFeeDisposition(Money.zero(), 'quote-id', market)).toBe('QUOTE'));
  it('quote feeProductId => QUOTE', () => expect(resolveFeeDisposition(FEE, 'quote-id', market)).toBe('QUOTE'));
  it('base feeProductId => BASE', () => expect(resolveFeeDisposition(FEE, 'base-id', market)).toBe('BASE'));
  it('unresolved feeProductId => UNKNOWN', () => expect(resolveFeeDisposition(FEE, 'other-id', market)).toBe('UNKNOWN'));
  it('missing feeProductId => UNKNOWN', () => expect(resolveFeeDisposition(FEE, null, market)).toBe('UNKNOWN'));
  it('negative fee => MALFORMED', () => expect(resolveFeeDisposition(Money.fromString('-1'), 'quote-id', market)).toBe('MALFORMED'));
  it('no market => UNKNOWN', () => expect(resolveFeeDisposition(FEE, 'quote-id', null)).toBe('UNKNOWN'));
});

describe('Reconciliation V1 — order classification', () => {
  it('terminal no-fill => CONFIRMED', () => {
    expect(classifyOrder({ localStatus: 'OPEN', exchangeStatus: 'CANCELED', exchangeExecutedQuantity: Money.zero(), provenExecuted: Money.zero(), completeness: 'COMPLETE' })).toBe('CONFIRMED');
  });
  it('FILLED with UNKNOWN completeness => OPERATOR_REQUIRED', () => {
    expect(classifyOrder({ localStatus: 'OPEN', exchangeStatus: 'FILLED', exchangeExecutedQuantity: QTY, provenExecuted: QTY, completeness: 'UNKNOWN' })).toBe('OPERATOR_REQUIRED');
  });
  it('FILLED with INCOMPLETE => OPERATOR_REQUIRED', () => {
    expect(classifyOrder({ localStatus: 'OPEN', exchangeStatus: 'FILLED', exchangeExecutedQuantity: QTY, provenExecuted: Money.fromString('0.05'), completeness: 'INCOMPLETE' })).toBe('OPERATOR_REQUIRED');
  });
  it('FILLED reporting zero executed quantity with proven executions => OPERATOR_REQUIRED (never CONFIRMED)', () => {
    const completeness = analyzeCompleteness(Money.zero(), Money.fromString('0.05'));
    expect(completeness).toBe('INCOMPLETE');
    expect(classifyOrder({ localStatus: 'OPEN', exchangeStatus: 'FILLED', exchangeExecutedQuantity: Money.zero(), provenExecuted: Money.fromString('0.05'), completeness })).toBe('OPERATOR_REQUIRED');
    expect(reservationDisposition({ hasReservation: true, exchangeStatus: 'FILLED', provenExecuted: Money.fromString('0.05'), accountingComplete: completeness === 'COMPLETE' })).toBe('RETAIN');
  });
  it('PARTIALLY_FILLED with incomplete => AMBIGUOUS', () => {
    expect(classifyOrder({ localStatus: 'OPEN', exchangeStatus: 'PARTIALLY_FILLED', exchangeExecutedQuantity: Money.fromString('0.4'), provenExecuted: Money.fromString('0.4'), completeness: 'UNKNOWN' })).toBe('AMBIGUOUS');
  });
  it('no exchange status => AMBIGUOUS', () => {
    expect(classifyOrder({ localStatus: 'UNKNOWN', exchangeStatus: null, exchangeExecutedQuantity: null, provenExecuted: Money.zero(), completeness: 'UNKNOWN' })).toBe('AMBIGUOUS');
  });
});

describe('Reconciliation V1 — reservation disposition', () => {
  it('terminal no-fill => RELEASE', () => {
    expect(reservationDisposition({ hasReservation: true, exchangeStatus: 'CANCELED', provenExecuted: Money.zero(), accountingComplete: true })).toBe('RELEASE');
  });
  it('FILLED incomplete => RETAIN', () => {
    expect(reservationDisposition({ hasReservation: true, exchangeStatus: 'FILLED', provenExecuted: QTY, accountingComplete: false })).toBe('RETAIN');
  });
  it('UNKNOWN => RETAIN', () => {
    expect(reservationDisposition({ hasReservation: true, exchangeStatus: null, provenExecuted: Money.zero(), accountingComplete: false })).toBe('RETAIN');
  });
  it('missing owner => RETAIN', () => {
    expect(reservationDisposition({ hasReservation: false, exchangeStatus: null, provenExecuted: Money.zero(), accountingComplete: false })).toBe('RETAIN');
  });
});

describe('Reconciliation V1 — balance reconciliation', () => {
  it('exact match => no mismatch', () => {
    const findings = reconcileBalances(new Map([['BTC', QTY]]), [{ currency: 'BTC', total: QTY, available: QTY, held: Money.zero() }]);
    expect(findings.some((f) => f.mismatch)).toBe(false);
  });
  it('precision mismatch => mismatch', () => {
    const findings = reconcileBalances(new Map([['BTC', QTY]]), [{ currency: 'BTC', total: Money.fromString('0.10000002'), available: Money.fromString('0.10000002'), held: Money.zero() }]);
    expect(findings.some((f) => f.mismatch)).toBe(true);
  });
  it('unexpected exchange inventory => mismatch, never auto-adopted', () => {
    const findings = reconcileBalances(new Map(), [{ currency: 'ETH', total: Money.fromString('1'), available: Money.fromString('1'), held: Money.zero() }]);
    expect(findings.some((f) => f.mismatch && /NOT auto-adopted/.test(f.reason))).toBe(true);
  });
});

describe('Reconciliation V1 — cross-domain', () => {
  it('orphan reservation is unresolved', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])).reserveOrder('orphan', 'CAD', Money.fromString('100'));
    const r = crossDomainValidation(new Map(), p, new Map(), new Map());
    expect(r.unresolved).toContain('orphan');
  });
  it('ACCOUNTED manual intent without settlement is unresolved', () => {
    const intent = { intentId: 'mi-1', status: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION' } as never;
    const r = crossDomainValidation(new Map(), null, new Map([['mi-1', intent]]), new Map());
    expect(r.unresolved).toContain('mi-1');
  });
});

describe('Reconciliation V1 — reconcile() read-only + commitProven()', () => {
  function makeDeps(stateDir: string): { deps: ReconciliationDeps; orders: OrderStore; live: ManagedStateStore; exchange: FakeExchange; liveFile: string } {
    const orders = new OrderStore(`${stateDir}/ledger.json`);
    const live = new ManagedStateStore(`${stateDir}/live.json`);
    const manualIntents = new ManualIntentStore(`${stateDir}/intents.json`);
    const exchange = new FakeExchange();
    return { deps: { stateDir, orders, live, manualIntents, adapter: exchange }, orders, live, exchange, liveFile: `${stateDir}/live.json` };
  }

  it('reconcile() does NOT mutate state; commitProven() applies a PROVEN execution', async () => {
    const stateDir = statePath('recv1', 'dir');
    const { deps, orders, live, exchange } = makeDeps(stateDir);

    const o = order('local-1', 'OPEN', '999001');
    o.filledQuantity = QTY;
    orders.save(o);

    const cash = new Map<string, Money>([['CAD', Money.fromString('100000')]]);
    live.save(Portfolio.empty(cash).stateModel);

    exchange.seedOrders([{ ...o, status: 'FILLED' }]);
    exchange.seedAccountTrades([trade('e1', '999001', QTY, FEE, 'quote-id')]);
    exchange.setMarkets([market]);
    exchange.setBalance('CAD', '100000');

    const result = await reconcile(deps);
    expect(result.status).toBe('RECONCILIATION_REQUIRED'); // FILLED completeness UNKNOWN
    expect(result.commitCandidates).toHaveLength(1);
    expect(result.commitCandidates[0]!.executionId).toBe('e1');

    // reconcile() must not have mutated the live portfolio.
    const before = live.load();
    expect(before.status).toBe('OK');
    if (before.status === 'OK') {
      const pf = live.toPortfolio(before.data)!;
      expect(pf.appliedCount()).toBe(0);
    }

    const committed = commitProven(deps, result);
    expect(committed.status).not.toBe('HALTED');
    const after = live.load();
    expect(after.status).toBe('OK');
    if (after.status === 'OK') {
      const pf = live.toPortfolio(after.data)!;
      expect(pf.appliedCount()).toBe(1);
      expect(pf.position(SYMBOL)!.quantity.toFixed(8)).toBe(QTY.toFixed(8));
      // Idempotent: re-committing the same result is a no-op.
      const again = commitProven(deps, result);
      expect(again.status).not.toBe('HALTED');
      const after2 = live.load();
      if (after2.status === 'OK') expect(live.toPortfolio(after2.data)!.appliedCount()).toBe(1);
    }
  });

  it('an ambiguous (clientOrderId-only) execution is never committed', async () => {
    const stateDir = statePath('recv1', 'dir2');
    const { deps, orders, live, exchange } = makeDeps(stateDir);
    const o = order('local-1', 'OPEN', '999001');
    orders.save(o);
    live.save(Portfolio.empty(new Map([['CAD', Money.fromString('100000')]])).stateModel);
    // Execution has NO exchange OrderId (only a clientOrderId) => not PROVEN.
    exchange.seedAccountTrades([{ ...trade('e1', '999001'), orderId: null, clientOrderId: 'local-1' }]);
    exchange.setMarkets([market]);
    const result = await reconcile(deps);
    expect(result.commitCandidates).toHaveLength(0);
    const committed = commitProven(deps, result);
    expect(committed.status).not.toBe('HALTED');
    const after = live.load();
    if (after.status === 'OK') expect(live.toPortfolio(after.data)!.appliedCount()).toBe(0);
  });

  it('commitProven refuses a BUY execution with insufficient cash and no reservation (no overdraw)', async () => {
    const stateDir = statePath('recv1', 'dir3');
    const { deps, orders, live, exchange } = makeDeps(stateDir);
    const o = order('local-1', 'OPEN', '999001');
    orders.save(o);
    // Live portfolio has too little cash and NO reservation for the BUY order.
    live.save(Portfolio.empty(new Map([['CAD', Money.fromString('10')]])).stateModel);
    exchange.seedOrders([{ ...o, status: 'FILLED' }]);
    exchange.seedAccountTrades([trade('e1', '999001', QTY, FEE, 'quote-id')]);
    exchange.setMarkets([market]);
    exchange.setBalance('CAD', '10');
    const result = await reconcile(deps);
    expect(result.commitCandidates).toHaveLength(1);
    const committed = commitProven(deps, result);
    expect(committed.status).toBe('HALTED');
    expect(committed.reasons.some((r) => /cash overdraw|exceeds deployable/.test(r))).toBe(true);
    const after = live.load();
    if (after.status === 'OK') {
      const pf = live.toPortfolio(after.data)!;
      expect(pf.appliedCount()).toBe(0); // nothing applied
      expect(pf.cash('CAD').toFixed(2)).toBe('10.00'); // cash untouched
    }
  });

  it('commitProven refuses a proven execution for an order that already has an operator attestation', async () => {
    const stateDir = statePath('recv1', 'dir4');
    const { deps, orders, live, exchange } = makeDeps(stateDir);
    // A SELL live order (attested resolution, no BUY reservation needed).
    const sellOrder: Order = {
      clientOrderId: 'local-1',
      exchangeOrderId: '999001',
      symbol: SYMBOL,
      side: 'SELL',
      type: 'limit',
      status: 'FILLED',
      quantity: QTY,
      filledQuantity: QTY,
      averagePrice: PRICE,
      price: PRICE,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'unknown',
      reason: 'test',
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    orders.save(sellOrder);
    // Portfolio: external BTC position + an operator attestation for the order.
    let pf = Portfolio.empty(new Map([['CAD', Money.zero()]]))
      .withExternalSnapshot(new Map([[SYMBOL, Money.fromString('0.2')]]))
      .authorizeExternal(SYMBOL);
    pf = pf.settleLiveOrderAttested({
      clientOrderId: 'local-1',
      symbol: SYMBOL,
      side: 'SELL',
      orderQuantity: QTY,
      exchangeOrderId: '999001',
      exchangeStatus: 'FILLED',
      attestedFilledQuantity: QTY,
      attestedAveragePrice: PRICE,
      fee: Money.zero(),
      feeCurrency: 'quote',
      evidenceSource: 'exchange_read',
      accountingAuthority: 'operator_attestation',
      provenanceProof: false,
      operatorConfirmedBy: 'op',
      attestedAtMs: 1,
      exchangeReadAtMs: 1,
      exchangeEvidence: {
        orderId: '999001', symbol: SYMBOL, side: 'SELL', type: 'limit', status: 'FILLED',
        quantity: QTY, filledQuantity: QTY, averagePrice: PRICE, limitPrice: PRICE,
        fee: Money.zero(), feeCurrency: 'unknown', reason: 'test', createdAtMs: 1, updatedAtMs: 1,
        orderEvidenceSource: 'status' as const,
        observedAccountTrades: [], observedBalances: [], readAtMs: 1,
      },
    });
    live.save(pf.stateModel);
    // Exchange now exposes a PROVEN execution for the same order (would otherwise
    // be committed). The attestation guard must refuse it.
    exchange.seedOrders([{ ...sellOrder, status: 'FILLED' }]);
    exchange.seedAccountTrades([trade('e1', '999001', QTY, FEE, 'quote-id', 'SELL')]);
    exchange.setMarkets([market]);
    exchange.setBalance('BTC', '0.1');
    exchange.setBalance('CAD', '12.00');
    const result = await reconcile(deps);
    expect(result.commitCandidates).toHaveLength(1);
    const committed = commitProven(deps, result);
    expect(committed.status).toBe('HALTED');
    expect(committed.reasons.some((r) => /operator attestation/.test(r))).toBe(true);
    const after = live.load();
    if (after.status === 'OK') {
      const afterPf = live.toPortfolio(after.data)!;
      expect(afterPf.appliedCount()).toBe(0); // no double accounting
    }
  });
});
