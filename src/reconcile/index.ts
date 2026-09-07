/**
 * Reconciliation module.
 *
 * Reconciliation is the safety loop that keeps the bot's local view of intent in
 * agreement with the exchange's authoritative account state. It is used before
 * placing live orders and on ambiguous outcomes (e.g. timeouts) where
 * re-submitting blindly could duplicate an order.
 *
 * V1 adds the two-phase `reconcile()` (read-only) / `commitProven()` (mutation)
 * orchestrator for execution correlation, completeness, fees, reservations,
 * balances and cross-domain validation.
 */

export { Reconciler, TERMINAL } from './Reconciler.js';
export { ReconcileService } from './ReconcileService.js';
export { reconcile, commitProven } from './orchestrator.js';
export type { ReconciliationDeps } from './orchestrator.js';
export { correlateExecution } from './executionCorrelation.js';
export type { CorrelationResult } from './executionCorrelation.js';
export { analyzeCompleteness } from './completeness.js';
export { resolveFeeDisposition, isFeeAutomatable } from './feeDisposition.js';
export { classifyOrder, isTerminalNoFill } from './orderReconciliation.js';
export { reservationDisposition } from './reservationReconciliation.js';
export { reconcileBalances } from './balanceReconciliation.js';
export { crossDomainValidation } from './crossDomain.js';
export type {
  ReconciliationResult,
  ReconciliationSnapshot,
  ExecutionFinding,
  OrderFinding,
  ReservationFinding,
  BalanceFinding,
  OperatorFinding,
  CommitCandidate,
  ReservationRelease,
  CorrelationLevel,
  Completeness,
  FeeDisposition,
  OrderDisposition,
  ReservationDisposition,
  OperatorFindingKind,
} from './reconciliationTypes.js';
export type {
  Discrepancy,
  ExchangeAccountSnapshot,
  LocalOrderLedger,
  ReconcileOptions,
  ReconcileReport,
} from './types.js';
