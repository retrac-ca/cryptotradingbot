/**
 * ReconcileService — fetches the exchange's authoritative account state and
 * reconciles it against the bot's local order ledger.
 *
 * Reads are gathered via the `ExchangeAdapter` account-read methods. A failure
 * to fetch any required view is treated as "cannot determine" (fail safe — the
 * reconciler returns `safeToTrade: false` rather than guessing). For LIVE
 * trading the exchange is authoritative; this service is the bridge between the
 * two views.
 */

import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { OrderStore } from '../persistence/OrderStore.js';
import { Reconciler, TERMINAL } from './Reconciler.js';
import type { ExchangeAccountSnapshot, LocalOrderLedger, ReconcileReport } from './types.js';

export class ReconcileService {
  constructor(
    private readonly adapter: ExchangeAdapter,
    private readonly store: OrderStore,
    private readonly reconciler: Reconciler = new Reconciler(),
  ) {}

  /**
   * Reconciler's view of local intent: all known orders, and which ones the bot
   * still believes are non-terminal.
   */
  localLedger(): LocalOrderLedger {
    const orders = this.store.allOrders();
    const openLocalOrderIds: string[] = [];
    for (const [id, o] of orders) {
      if (!TERMINAL.has(o.status)) openLocalOrderIds.push(id);
    }
    return { orders, openLocalOrderIds };
  }

  /**
   * Reconcile against the live exchange. Fails safe (safeToTrade=false) if any
   * read fails or if a discrepancy is found.
   */
  async reconcile(): Promise<ReconcileReport> {
    const snapshot = await this.fetchSnapshot();
    return this.reconciler.reconcile(this.localLedger(), snapshot);
  }

  /**
   * Fetch the authoritative account snapshot. On a read failure we return a
   * partially-populated snapshot marker so the reconciler can fail closed.
   */
  async fetchSnapshot(): Promise<ExchangeAccountSnapshot> {
    const base: ExchangeAccountSnapshot = {
      balances: [],
      openOrders: [],
      orderHistory: [],
      fetchedAtMs: Date.now(),
    };
    let ok = true;
    try {
      base.balances = await this.adapter.getBalances();
    } catch (err) {
      ok = false;
      this.markFailure(err, 'getBalances');
    }
    try {
      base.openOrders = await this.adapter.getOpenOrders();
    } catch (err) {
      ok = false;
      this.markFailure(err, 'getOpenOrders');
    }
    try {
      base.orderHistory = await this.adapter.getOrderHistory();
    } catch (err) {
      ok = false;
      this.markFailure(err, 'getOrderHistory');
    }
    // If anything failed, discard the partial reads so reconciliation fails
    // closed instead of comparing against an incomplete picture.
    return ok ? base : { ...base, balances: undefined as never, openOrders: undefined as never, orderHistory: undefined as never };
  }

  private markFailure(err: unknown, method: string): void {
    // Swallow for now; the returned "incomplete" snapshot drives fail-closed.
    void err;
    void method;
  }
}
