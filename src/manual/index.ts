/**
 * Manual-execution bridge module (Gate 9).
 *
 * This is the Operator-Executed trade path: RETRAC proposes, the operator
 * executes externally on the exchange's authoritative interface, and RETRAC
 * records evidence, validates against a read, and accounts at the ORDER level
 * through a deliberately separate, explicitly-reviewed path. It NEVER submits
 * or cancels an order.
 */

export { ManualIntentStore, CorruptManualIntentStoreError } from './ManualIntentStore.js';
export type { ManualIntentFile } from './ManualIntentStore.js';
export { ManualTradeBridge } from './bridge.js';
export type { ManualBridgeDeps, SettleOptions, CancelOptions } from './bridge.js';
export {
  validateEvidenceStructural,
  validateEvidenceAgainstExchange,
  evidenceProgressConflict,
  bindOrderToIntent,
  isTerminalStatus,
  isTerminalNoFill,
} from './validation.js';
export type {
  StructuralValidation,
  StructuralDisposition,
  ExchangeValidation,
  OrderBinding,
} from './validation.js';
export {
  MANUAL_INTENT_STATUS,
  MANUAL_ACCOUNTED_STATUSES,
  MANUAL_TERMINAL_STATUSES,
  MANUAL_BLOCKED_STATUSES,
  isAccountedStatus,
  isTerminalManualStatus,
  isBlockedManualStatus,
  EVIDENCE_SOURCE,
} from './types.js';
export type {
  ManualTradeIntent,
  ManualIntentStatus,
  ManualAccountedStatus,
  ManualEvidence,
  ManualRiskSnapshot,
  ManualProposeOptions,
  RecordEvidenceInput,
  ProposalResult,
  SettleOutcome,
  AccountingAuthority,
  EvidenceSource,
  ManualEvent,
  ManualReconcileIssue,
  ManualReconcileReport,
  ManualReconcileSeverity,
} from './types.js';
