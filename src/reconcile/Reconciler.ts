/**
 * Reconciler — compares the bot's local order ledger against the exchange's
 * authoritative account state and classifies discrepancies.
 *
 * Safety principle: the exchange is authoritative. We never "fix" a discrepancy
 * by guessing. Instead we surface it so a human/engine can decide, and we flag
 * `safeToTrade = false` whenever the local and exchange views cannot be brought
 * into agreement. In particular, an order the bot thinks is open but that the
 * exchange no longer shows must be treated as a discrepancy, never as a reason
 * to blindly re-submit.
 */

import type { Order } from '../order.js';
import { Money } from '../money/Money.js';
import type {
  Discrepancy,
  ExchangeAccountSnapshot,
  LocalOrderLedger,
  ReconcileOptions,
  ReconcileReport,
} from './types.js';

const TERMINAL: ReadonlySet<string> = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'ABANDONED']);

/** Default tolerance for balance comparison: one smallest unit (exact by default). */
const DEFAULT_BALANCE_TOLERANCE = Money.fromString('0.00000001');

export class Reconciler {
  /**
   * Reconcile local ledger against an exchange snapshot.
   *
   * `snapshot` is normally produced by `ReconcileService.fetchSnapshot`, which
   * returns a partial snapshot when reads fail. If the snapshot itself is
   * incomplete (missing balances/open orders/history), we cannot determine
   * consistency and fail safe.
   *
   * Optional `ReconcileOptions.expectedBalances` enables local-vs-exchange
   * available-balance drift detection (see ReconcileOptions for the rules).
   */
  reconcile(
    local: LocalOrderLedger,
    snapshot: ExchangeAccountSnapshot,
    options: ReconcileOptions = {},
  ): ReconcileReport {
    const discrepancies: Discrepancy[] = [];

    // If reads are missing/incomplete, fail safe: consistency is unknowable.
    if (!snapshot.balances || !snapshot.openOrders || !snapshot.orderHistory) {
      discrepancies.push({
        kind: 'CANNOT_DETERMINE',
        detail: 'exchange account reads are missing/incomplete; consistency cannot be determined',
      });
      return {
        consistent: false,
        safeToTrade: false,
        discrepancies,
        balances: snapshot.balances ?? [],
        openOrders: snapshot.openOrders ?? [],
        ordersMatchedByClientId: 0,
        ordersMatchedByExchangeId: 0,
        checkedAtMs: snapshot.fetchedAtMs,
      };
    }

    // Index exchange open orders by clientOrderId and by exchangeOrderId.
    const openByClientId = new Map<string, Order>();
    const openByExchangeId = new Map<string, Order>();
    for (const o of snapshot.openOrders) {
      if (o.clientOrderId && o.clientOrderId !== '0') openByClientId.set(o.clientOrderId, o);
      if (o.exchangeOrderId) openByExchangeId.set(o.exchangeOrderId, o);
    }

    let matchedClient = 0;
    let matchedExchange = 0;

    // 1) Every order the bot thinks is open must appear on the exchange.
    for (const id of local.openLocalOrderIds) {
      const localOrder = local.orders.get(id);
      const onExchange = openByClientId.get(id) ?? openByExchangeId.get(localOrder?.exchangeOrderId ?? '');
      if (onExchange) {
        matchedClient += openByClientId.has(id) ? 1 : 0;
        matchedExchange += onExchange.exchangeOrderId === localOrder?.exchangeOrderId ? 1 : 0;
      } else {
        // The exchange does not show an order we believe is open. This is a
        // discrepancy — do not re-submit; reconcile (it may have filled/canceled).
        discrepancies.push({
          kind: 'LOCAL_OPEN_MISSING_ON_EXCHANGE',
          clientOrderId: id,
          exchangeOrderId: localOrder?.exchangeOrderId ?? null,
          detail: `bot believes order ${id} is open but it is not in exchange open orders`,
        });
      }
    }

    // 2) Orders the bot knows about (from history/ledger) with a known
    //    exchangeOrderId: if the exchange reports a terminal status different
    //    from ours, flag a mismatch.
    for (const [id, localOrder] of local.orders) {
      if (!localOrder.exchangeOrderId) continue;
      const matched = snapshot.orderHistory.find(
        (o) => o.exchangeOrderId === localOrder.exchangeOrderId || o.clientOrderId === id,
      );
      if (!matched) continue;
      const localTerminal = TERMINAL.has(localOrder.status);
      const exTerminal = TERMINAL.has(matched.status);
      if (localTerminal !== exTerminal && localOrder.status !== matched.status) {
        discrepancies.push({
          kind: 'LOCAL_ORDER_STATUS_MISMATCH',
          clientOrderId: id,
          exchangeOrderId: localOrder.exchangeOrderId,
          detail: `local=${localOrder.status}, exchange=${matched.status}`,
        });
      }
    }

    // 3) Exchange open orders we don't recognize as our own. An order is "ours"
    //    only if it is present in the bot's local ledger (matched by
    //    clientOrderId or by its exchange id).
    for (const o of snapshot.openOrders) {
      const knownByClient = o.clientOrderId && local.orders.has(o.clientOrderId);
      const knownByExchange =
        o.exchangeOrderId &&
        [...local.orders.values()].some((lo) => lo.exchangeOrderId === o.exchangeOrderId);
      if (!knownByClient && !knownByExchange) {
        discrepancies.push({
          kind: 'EXCHANGE_ORDER_UNKNOWN_LOCALLY',
          symbol: o.symbol,
          clientOrderId: o.clientOrderId || undefined,
          exchangeOrderId: o.exchangeOrderId,
          detail: `exchange has open order not created by this bot`,
        });
      }
    }

    // 4) Balance sanity: no negative available balances.
    for (const b of snapshot.balances) {
      if (b.total.isNegative()) {
        discrepancies.push({
          kind: 'BALANCE_NEGATIVE',
          currency: b.currency,
          detail: `negative total balance for ${b.currency}`,
        });
      }
    }

    // 5) Local-vs-exchange expected balance drift detection (when enabled).
    if (options.expectedBalances) {
      this.checkExpectedBalances(options.expectedBalances, snapshot, options, discrepancies);
    }

    const consistent = discrepancies.length === 0;
    return {
      consistent,
      // Fail safe: trade only when fully consistent.
      safeToTrade: consistent,
      discrepancies,
      balances: snapshot.balances,
      openOrders: snapshot.openOrders,
      ordersMatchedByClientId: matchedClient,
      ordersMatchedByExchangeId: matchedExchange,
      checkedAtMs: snapshot.fetchedAtMs,
    };
  }

  /**
   * Compare locally-expected available balances against the exchange's
   * authoritative balances, per ReconcileOptions rules. Never guesses or
   * overwrites local state — it only flags a discrepancy.
   */
  private checkExpectedBalances(
    expected: Map<string, Money>,
    snapshot: ExchangeAccountSnapshot,
    options: ReconcileOptions,
    discrepancies: Discrepancy[],
  ): void {
    const tolerance = options.balanceTolerance ?? DEFAULT_BALANCE_TOLERANCE;
    const byCurrency = new Map(snapshot.balances.map((b) => [b.currency, b]));

    for (const [currency, expectedAvailable] of expected) {
      const exchange = byCurrency.get(currency);
      if (!exchange) {
        // We expect this currency but the exchange shows none — cannot confirm.
        discrepancies.push({
          kind: 'BALANCE_MISMATCH',
          currency,
          detail: `expected local ${currency} balance ${expectedAvailable.toString()} but exchange reports no ${currency} balance`,
        });
        continue;
      }
      const diff = expectedAvailable.sub(exchange.available);
      const absDiff = diff.isNegative() ? diff.negate() : diff;
      if (absDiff.compareTo(tolerance) > 0) {
        discrepancies.push({
          kind: 'BALANCE_MISMATCH',
          currency,
          detail: `local ${currency} available ${expectedAvailable.toString()} != exchange ${exchange.available.toString()} (diff ${absDiff.toString()} > tol ${tolerance.toString()})`,
        });
      }
    }
  }
}

export { TERMINAL };
