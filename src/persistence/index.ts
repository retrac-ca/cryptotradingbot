/**
 * Persistence module (Persistence & Restart Recovery).
 *
 * Provides the durable state stores (paper, live-managed, order ledger, manual
 * intents), a fail-closed tri-state load model, a versioned state envelope, a
 * single state-directory mutation lock, a first-ever initialization marker, and
 * a startup recovery coordinator.
 */

export { PaperStateStore } from './PaperStateStore.js';
export type { PaperStatePayload } from './PaperStateStore.js';
export { ManagedStateStore } from './ManagedStateStore.js';
export type { ManagedStatePayload } from './ManagedStateStore.js';
export { OrderStore } from './OrderStore.js';
export type { OrderLedgerPayload, OrderLedgerV1 } from './OrderStore.js';
export { readEnvelope, writeEnvelope, STATE_FORMAT, STATE_VERSION } from './envelope.js';
export type { StateEnvelope } from './envelope.js';
export { withStateDirLock, lockPathFor, isLockHeld } from './lock.js';
export type { LockMetadata } from './lock.js';
export { StateInitMarker } from './init.js';
export type { StateInitPayload } from './init.js';
export { recoverState, requireOk } from './recovery.js';
export type { RecoveryInputs } from './recovery.js';
export { migrateLegacyState } from './migration.js';
export {
  CorruptStateError,
  StateLockedError,
} from './types.js';
export type {
  LoadResult,
  StateRealm,
  StateDomain,
  RecoveryStatus,
  RecoveryReport,
} from './types.js';
