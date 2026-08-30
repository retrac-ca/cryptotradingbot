/**
 * Reconciliation domain types.
 *
 * Reconciliation compares the bot's LOCAL ledger of intent (orders we tried to
 * place, expected states) against the EXCHANGE'S authoritative state (balances,
 * open orders, order history). The goal is to detect discrepancies and FAIL
 * SAFELY rather than guess — in particular, never to blindly re-submit an order
 * whose outcome is unknown.
 *
 * The exchange is always treated as authoritative for actual balances/orders.
 */

import type { Balance } from '../types.js';
import type { Order } from '../order.js';
import type { Money } from '../money/Money.js';

/** The exchange's authoritative snapshot of the account. */
export interface ExchangeAccountSnapshot {
  balances: Balance[];
  openOrders: Order[];
  orderHistory: Order[];
  fetchedAtMs: number;
}

/** The bot's local ledger of what it intended and observed. */
export interface LocalOrderLedger {
  /** Order by clientOrderId (all known attempts). */
  orders: Map<string, Order>;
  openLocalOrderIds: string[];
}

/** A single discrepancy between local intent and exchange state. */
export interface Discrepancy {
  kind:
    | 'LOCAL_OPEN_MISSING_ON_EXCHANGE' // bot thinks open, exchange has no such order
    | 'LOCAL_ORDER_STATUS_MISMATCH' // same order, different status (e.g. filled vs open)
    | 'EXCHANGE_ORDER_UNKNOWN_LOCALLY' // exchange has an order the bot doesn't know
    | 'BALANCE_NEGATIVE'
    | 'BALANCE_MISMATCH' // local vs exchange balance differs
    | 'CANNOT_DETERMINE'; // exchange read failed / ambiguous -> fail safely
  symbol?: string;
  currency?: string;
  clientOrderId?: string;
  exchangeOrderId?: string | null;
  detail?: string;
}

export interface ReconcileReport {
  /** True iff the account can be considered consistent (no material discrepancy). */
  consistent: boolean;
  safeToTrade: boolean;
  discrepancies: Discrepancy[];
  balances: Balance[];
  openOrders: Order[];
  ordersMatchedByClientId: number;
  ordersMatchedByExchangeId: number;
  checkedAtMs: number;
}

/** How the reconciler is told to proceed when reads fail (fail safe by default). */
export interface ReconcileOptions {
  /** Expected local quote balances keyed by currency (for drift detection). */
  expectedBalances?: Map<string, Money>;
}
