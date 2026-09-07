/**
 * Persistence domain types (Persistence & Restart Recovery).
 *
 * All durable state is read through a fail-closed TRI-STATE result, so a caller
 * can ALWAYS distinguish:
 *   - OK      — the file exists, parses, and passes schema/invariant validation;
 *   - MISSING — the filesystem reports ENOENT for the target (the ONLY case
 *               that may be "legitimately absent");
 *   - CORRUPT — everything else (malformed JSON, zero-byte/whitespace, JSON
 *               null, `{}`, invalid envelope, realm/domain mismatch, unsupported
 *               version, invalid Money/enum/conservation/reservation, leftover
 *               `.tmp`, ...).
 *
 * CORRUPT is NEVER turned into MISSING, and CORRUPT never silently initializes
 * fresh financial state.
 */

/** The realm a state document belongs to. `global` is for the init marker. */
export type StateRealm = 'paper' | 'live' | 'global';

/** The domain/kind of a state document. */
export type StateDomain = 'portfolio' | 'order-ledger' | 'manual-intents' | 'state-init';

/** Fail-closed tri-state load result. */
export type LoadResult<T> =
  | { status: 'OK'; data: T }
  | { status: 'MISSING' }
  | { status: 'CORRUPT'; reason: string };

/**
 * Raised when durable state is corrupt / cannot be safely loaded. Callers treat
 * this as a HALT (operator intervention), never as "no state".
 */
export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/** Raised when a state-directory mutation lock is held (or malformed). */
export class StateLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateLockedError';
  }
}

/** Startup recovery classification. */
export type RecoveryStatus = 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED';

export interface RecoveryReport {
  status: RecoveryStatus;
  /** Human-readable reasons for the status (corruption, unresolved ops, etc.). */
  reasons: string[];
  /** Local clientOrderIds that are unresolved (non-terminal / UNKNOWN). */
  unresolvedOrders: string[];
  /** Reservation identifiers that are orphaned / uncertain. */
  unresolvedReservations: string[];
  /** Manual intent ids that are non-terminal / AMBIGUOUS / RECONCILIATION_REQUIRED. */
  unresolvedIntents: string[];
  /** Cross-file contradictions: one durable file disagrees with another (e.g. an
   * orphan reservation with no corresponding order/intent, or an ACCOUNTED
   * manual intent with no portfolio settlement). These are always unsafe to
   * operate on and must be resolved before the realm may begin operating. */
  crossFileIssues: string[];
  /** True when a read-only exchange reconciliation is required before trading. */
  requiresExchangeRead: boolean;
}
