import { describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { OrderStore } from '../../../src/persistence/OrderStore.js';
import { ReconcileService, Reconciler } from '../../../src/reconcile/index.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { ExchangeAccountSnapshot, LocalOrderLedger } from '../../../src/reconcile/types.js';
import type { Balance } from '../../../src/types.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('ownrec', 'ledger.json');
const SYMBOL = 'BTC/CAD';

function bal(currency: string, amount: string): Balance {
  return { currency, total: Money.fromString(amount), available: Money.fromString(amount), held: Money.zero() };
}

function port(managedBtc: string, externalBtc: string, cad: string): Portfolio {
  let p = Portfolio.empty(new Map([['CAD', Money.fromString(cad)]]));
  if (Money.fromString(managedBtc).isPositive()) {
    p = p.applyFill(SYMBOL, 'BUY', Money.fromString(managedBtc), Money.fromString('40000'), Money.zero());
  }
  if (Money.fromString(externalBtc).isPositive()) {
    p = p.withExternalSnapshot(new Map([[SYMBOL, Money.fromString(externalBtc)]]));
  }
  return p;
}

function snapshot(balances: Balance[]): ExchangeAccountSnapshot {
  return { balances, openOrders: [], orderHistory: [], fetchedAtMs: Date.now() };
}

describe('Ownership-aware reconciliation', () => {
  it('is consistent when exchange matches managed + external', () => {
    const local: LocalOrderLedger = { orders: new Map(), openLocalOrderIds: [] };
    const r = new Reconciler();
    const report = r.reconcile(
      local,
      snapshot([bal('BTC', '0.25'), bal('CAD', '100000')]),
      { expectedBalances: new Map([['BTC', Money.fromString('0.25')]]) },
    );
    expect(report.consistent).toBe(true);
    expect(report.safeToTrade).toBe(true);
  });

  it('flags an unexpected deposit/manual buy: it is NOT auto-adopted (fail-safe)', () => {
    const local: LocalOrderLedger = { orders: new Map(), openLocalOrderIds: [] };
    const r = new Reconciler();
    // Exchange shows 0.30 BTC but the bot accounts for 0.25 -> unexplained gain.
    const report = r.reconcile(
      local,
      snapshot([bal('BTC', '0.30'), bal('CAD', '100000')]),
      { expectedBalances: new Map([['BTC', Money.fromString('0.25')]]) },
    );
    expect(report.consistent).toBe(false);
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies.some((d) => d.kind === 'BALANCE_MISMATCH')).toBe(true);
  });

  it('flags an unexplained withdrawal/manual sell without mutating managed ownership', () => {
    const local: LocalOrderLedger = { orders: new Map(), openLocalOrderIds: [] };
    const r = new Reconciler();
    // Exchange shows 0.20 BTC but the bot accounts for 0.25 -> unexplained loss.
    const report = r.reconcile(
      local,
      snapshot([bal('BTC', '0.20'), bal('CAD', '100000')]),
      { expectedBalances: new Map([['BTC', Money.fromString('0.25')]]) },
    );
    expect(report.consistent).toBe(false);
    expect(report.safeToTrade).toBe(false);
  });

  it('derives expectedBalances from the managed portfolio (managed + external by base)', () => {
    const p = port('0.1', '0.15', '1000');
    const expected = p.expectedAssetBalances();
    expect(expected.get('BTC')!.toFixed(8)).toBe('0.25000000');
    expect(expected.has('CAD')).toBe(false);
  });

  it('does not adopt unexpected crypto: managed position stays unchanged after reconcile', () => {
    const p = port('0.1', '0.0', '1000');
    const before = p.position(SYMBOL)!.quantity.toFixed(8);
    // Reconciling does not mutate the portfolio.
    const r = new Reconciler();
    r.reconcile(
      { orders: new Map(), openLocalOrderIds: [] },
      snapshot([bal('BTC', '0.30'), bal('CAD', '1000')]),
      { expectedBalances: p.expectedAssetBalances() },
    );
    expect(p.position(SYMBOL)!.quantity.toFixed(8)).toBe(before);
    expect(p.external(SYMBOL).isZero()).toBe(true);
  });

  it('unknown order remains unsafe (LOCAL_OPEN_MISSING_ON_EXCHANGE)', async () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { BTC: '0.25', CAD: '1000' }, markets: { [SYMBOL]: {} as never } });
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    store.save({
      clientOrderId: 'orphan',
      exchangeOrderId: null,
      symbol: SYMBOL,
      side: 'BUY',
      type: 'market',
      status: 'SUBMITTED',
      quantity: Money.fromString('0.1'),
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'quote',
      reason: 'seed',
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    const report = await service.reconcile();
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies.some((d) => d.kind === 'LOCAL_OPEN_MISSING_ON_EXCHANGE')).toBe(true);
    rmSync(LEDGER, { force: true });
  });

  it('is wired end-to-end via ReconcileService.reconcile(options)', async () => {
    rmSync(LEDGER, { force: true });
    const exchange = new FakeExchange({ balances: { BTC: '0.25', CAD: '1000' }, markets: { [SYMBOL]: {} as never } });
    const store = new OrderStore(LEDGER);
    const service = new ReconcileService(exchange, store);
    const p = port('0.25', '0', '1000');
    const report = await service.reconcile({ expectedBalances: p.expectedAssetBalances() });
    expect(report.consistent).toBe(true);
    expect(report.safeToTrade).toBe(true);
    rmSync(LEDGER, { force: true });
  });
});
