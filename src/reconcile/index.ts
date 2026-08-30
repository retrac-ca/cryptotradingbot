/**
 * Reconciliation module.
 *
 * Reconciliation is the safety loop that keeps the bot's local view of intent
 * in agreement with the exchange's authoritative account state. It is used
 * before placing live orders and on ambiguous outcomes (e.g. timeouts) where
 * re-submitting blindly could duplicate an order.
 */

export { Reconciler, TERMINAL } from './Reconciler.js';
export { ReconcileService } from './ReconcileService.js';
export type {
  Discrepancy,
  ExchangeAccountSnapshot,
  LocalOrderLedger,
  ReconcileOptions,
  ReconcileReport,
} from './types.js';
