/**
 * P2-2 — CREATED-order guard, fail-closed recovery, and terminal ABANDONED.
 *
 * A durable LIVE CREATED order (exchangeOrderId=null) is fundamentally
 * ambiguous: the bot cannot prove whether NDAX received it. It must block new
 * LIVE placement and remain unresolved (never auto-resolved). An operator can
 * only close it explicitly (`bot resolve-created-order`); an ABANDONED order is
 * terminal locally and is not resurrected by restart or reconciliation.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import {
  PaperStateStore,
  ManagedStateStore,
  StateInitMarker,
  recoverState,
} from '../../../src/persistence/index.js';
import { ManualIntentStore } from '../../../src/manual/index.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { ReconcileService } from '../../../src/reconcile/ReconcileService.js';
import { classifyOrder } from '../../../src/reconcile/index.js';
import { LiveOrderEngine } from '../../../src/execution/LiveExecutionEngine.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';
import type { Order } from '../../../src/order.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const CLIENT = 'live-BTCCAD-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SYMBOL = 'BTC/CAD';
const NOW = 1_000_000;

const market: MarketInfo = {
  symbol: SYMBOL,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'),
  minOrderQuote: Money.fromString('1'),
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

function riskConfig(): RiskConfig {
  return {
    maxTradeAmount: Money.fromString('1000000'),
    maxPositionSizeFraction: 1,
    maxPortfolioExposureFraction: 1,
    maxDailyLossFraction: 1,
    maxDrawdownFraction: 1,
    cooldownAfterLossMs: 0,
    maxOpenPositions: 1,
    marketDataMaxAgeMs: 60_000,
    marketDataTransportMaxAgeMs: 60_000,
    maxClockSkewMs: 120_000,
  };
}

function riskContext(): RiskContext {
  const bal: Balance = {
    currency: 'CAD',
    total: Money.fromString('100000'),
    available: Money.fromString('100000'),
    held: Money.zero(),
  };
  return {
    symbol: SYMBOL,
    signal: signal(SYMBOL, 'BUY'),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: Money.fromString('40000'),
    marketInfo: market,
    quoteBalance: bal,
    deployableQuote: Money.fromString('1000000'),
    portfolioValue: Money.fromString('100000'),
    peakPortfolioValue: Money.fromString('100000'),
    portfolioExposure: Money.fromString('0'),
    currentPosition: Money.fromString('0'),
    externalPosition: Money.fromString('0'),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.fromString('0'),
    unrealizedPnlToday: Money.fromString('0'),
  };
}

function order(over: Partial<Order> = {}): Order {
  return {
    clientOrderId: CLIENT,
    exchangeOrderId: null,
    symbol: SYMBOL,
    side: 'SELL',
    type: 'limit',
    status: 'CREATED',
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: Money.fromString('40000'),
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'unknown',
    reason: 'live-test SELL',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  };
}

function abandonedOrder(): Order {
  return order({
    status: 'ABANDONED',
    resolution: {
      kind: 'ABANDON',
      operator: 'operator-alice',
      reason: 'cannot determine exchange outcome',
      resolvedAtMs: NOW,
      accountingAuthority: 'operator_attestation',
      provenanceProof: false,
      exchangeOrderId: null,
      evidence: 'read-only review',
    },
  });
}

function buildEngine(fake: FakeExchange, ledger: string): LiveOrderEngine {
  fake.setTicker(SYMBOL, { last: Money.fromString('40000') });
  const store = new OrderStore(ledger);
  const service = new ReconcileService(fake, store);
  return new LiveOrderEngine(fake, store, service, new RiskManager(riskConfig()), {
    gate: { tradingMode: 'live', realFundsAtRisk: true },
    killSwitch: false,
    maxLiveQuoteNotional: Money.fromString('1000000'),
    maxLiveBaseQuantity: Money.fromString('100'),
  });
}

function recoveryInputs(ledger: string) {
  const dir = dirname(ledger);
  const paper = new PaperStateStore(join(dir, 'paper.json'));
  paper.save(Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])).stateModel, []);
  const initMarker = new StateInitMarker(join(dir, '.init.json'));
  initMarker.markInitialized('paper');
  return {
    paper,
    live: new ManagedStateStore(join(dir, 'live.json')),
    orders: new OrderStore(ledger),
    manualIntents: new ManualIntentStore(join(dir, 'intents.json')),
    initMarker,
  };
}

describe('P2-2 — CREATED blocks new LIVE placement', () => {
  it('a durable CREATED live order refuses a new LIVE order before any exchange contact', async () => {
    const ledger = statePath('p22-guard', 'ledger.json');
    const fake = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(fake, ledger);
    new OrderStore(ledger).save(order({ status: 'CREATED' }));

    await expect(
      engine.place(riskContext(), { reason: 'blocked', type: 'limit', price: Money.fromString('40000') }),
    ).rejects.toThrow(/unresolved LIVE order/);
    expect(fake.submittedOrders).toHaveLength(0);
  });
});

describe('P2-2 — existing CREATED recovery remains fail-closed', () => {
  it('recoverState flags a CREATED order as RECONCILIATION_REQUIRED', () => {
    const ledger = statePath('p22-recover', 'ledger.json');
    new OrderStore(ledger).save(order({ status: 'CREATED' }));
    const report = recoverState(recoveryInputs(ledger));
    expect(report.status).toBe('RECONCILIATION_REQUIRED');
    expect(report.unresolvedOrders).toContain(CLIENT);
    expect(report.requiresExchangeRead).toBe(true);
  });

  it('recoverOrder cannot auto-resolve a CREATED order (stays CREATED, no retry)', async () => {
    const ledger = statePath('p22-auto', 'ledger.json');
    const fake = new FakeExchange({ balances: { CAD: '100000' }, markets: { [SYMBOL]: market } });
    const engine = buildEngine(fake, ledger);
    const res = await engine.recoverOrder(order({ status: 'CREATED' }));
    expect(res.outcome).toBe('UNRESOLVED');
    expect(res.order.status).toBe('CREATED');
    expect(res.order.exchangeOrderId).toBeNull();
    expect(fake.submittedOrders).toHaveLength(0);
  });
});

describe('P2-2 — ABANDONED is terminal and durable', () => {
  it('recoverState treats an ABANDONED order as terminal (READY, not unresolved)', () => {
    const ledger = statePath('p22-abandon', 'ledger.json');
    new OrderStore(ledger).save(abandonedOrder());
    const report = recoverState(recoveryInputs(ledger));
    expect(report.status).toBe('READY');
    expect(report.unresolvedOrders).toEqual([]);
  });

  it('a restart reload preserves ABANDONED and its audit (no resurrection)', () => {
    const ledger = statePath('p22-restart', 'ledger.json');
    new OrderStore(ledger).save(abandonedOrder());
    const reloaded = new OrderStore(ledger).get(CLIENT)!;
    expect(reloaded.status).toBe('ABANDONED');
    expect(reloaded.resolution?.kind).toBe('ABANDON');
    expect(reloaded.resolution?.operator).toBe('operator-alice');
    expect(reloaded.resolution?.provenanceProof).toBe(false);
  });

  it('reconciliation does not treat ABANDONED as an unresolved live order', () => {
    const ledger = statePath('p22-reconcile', 'ledger.json');
    const store = new OrderStore(ledger);
    store.save(abandonedOrder());
    const fake = new FakeExchange();
    const service = new ReconcileService(fake, store);
    expect(service.localLedger().openLocalOrderIds).not.toContain(CLIENT);
    expect(
      classifyOrder({
        localStatus: 'ABANDONED',
        exchangeStatus: null,
        exchangeExecutedQuantity: null,
        provenExecuted: Money.zero(),
        completeness: 'UNKNOWN',
      }),
    ).toBe('CONFIRMED');
  });

  it('a tampered resolution record fails the ledger closed (CORRUPT)', () => {
    const ledger = statePath('p22-tamper', 'ledger.json');
    new OrderStore(ledger).save(abandonedOrder());
    const raw = JSON.parse(readFileSync(ledger, 'utf8')) as { payload: { orders: Record<string, { resolution: { provenanceProof: boolean } }> } };
    raw.payload.orders[CLIENT]!.resolution.provenanceProof = true;
    writeFileSync(ledger, JSON.stringify(raw));
    expect(new OrderStore(ledger).load().status).toBe('CORRUPT');
  });
});
