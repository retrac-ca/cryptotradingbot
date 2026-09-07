/**
 * Startup recovery coordinator (Persistence & Restart Recovery).
 *
 * Persistence/recovery DETECTS and RETAINS unresolved state and HALTS trading
 * when uncertain. It never resolves exchange truth itself — that is the
 * reconciliation subsystem's job (read-only). Corruption is ALWAYS HALTED;
 * unresolved-but-valid state is RECONCILIATION_REQUIRED; only fully-consistent,
 * no-unresolved state is READY.
 */

import { isAccountedStatus, isBlockedManualStatus, isTerminalManualStatus } from '../manual/types.js';
import type { ManualIntentStore } from '../manual/ManualIntentStore.js';
import type { ManagedStateStore } from './ManagedStateStore.js';
import type { OrderStore } from './OrderStore.js';
import type { PaperStateStore } from './PaperStateStore.js';
import type { StateInitMarker } from './init.js';
import type { LoadResult, RecoveryReport, RecoveryStatus } from './types.js';

const NON_TERMINAL_ORDER_STATUS: ReadonlySet<string> = new Set(['CREATED', 'SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN']);

export interface RecoveryInputs {
  paper: PaperStateStore;
  live: ManagedStateStore;
  orders: OrderStore;
  manualIntents: ManualIntentStore;
  initMarker: StateInitMarker;
}

/**
 * Produce a startup recovery report for the state directory.
 *
 * Does NOT acquire the mutation lock (that is the caller's responsibility when
 * it intends to mutate/init). It only reads state and classifies.
 */
export function recoverState(inputs: RecoveryInputs): RecoveryReport {
  const reasons: string[] = [];
  const unresolvedOrders: string[] = [];
  const unresolvedReservations: string[] = [];
  const unresolvedIntents: string[] = [];
  const crossFileIssues: string[] = [];
  let requiresExchangeRead = false;
  let status: RecoveryStatus = 'READY';
  let halted = false;

  const halt = (reason: string): void => {
    reasons.push(reason);
    status = 'HALTED';
    halted = true;
  };

  // --- Initialization marker ---
  const init = inputs.initMarker.load();
  let paperInit = false;
  let liveInit = false;
  if (init.status === 'CORRUPT') {
    halt(`state init marker is corrupt: ${init.reason}`);
  } else if (init.status === 'OK') {
    paperInit = init.data.realms.paper;
    liveInit = init.data.realms.live;
  }

  // --- Paper state ---
  const paper = inputs.paper.load();
  if (paper.status === 'CORRUPT') {
    halt(`paper state is corrupt: ${paper.reason}`);
  } else if (paper.status === 'MISSING') {
    if (paperInit) {
      halt('paper state is missing but the paper realm was already initialized (unexpected state loss)');
    } else {
      reasons.push('paper realm not yet initialized (first-ever run)');
    }
  }
  // else OK: portfolio conservation/reservation invariants already validated by the store.

  // --- Live managed state ---
  const live = inputs.live.load();
  if (live.status === 'CORRUPT') {
    halt(`live managed state is corrupt: ${live.reason}`);
  } else if (live.status === 'MISSING') {
    if (liveInit) {
      halt('live managed state is missing but the live realm was already initialized (unexpected state loss)');
    } else {
      reasons.push('live realm not yet initialized (no managed inventory yet)');
    }
  }

  // --- Order ledger ---
  const orders = inputs.orders.load();
  if (orders.status === 'CORRUPT') {
    halt(`order ledger is corrupt: ${orders.reason}`);
  } else if (orders.status === 'OK') {
    for (const [id, o] of Object.entries(orders.data.orders)) {
      if (NON_TERMINAL_ORDER_STATUS.has(o.status)) {
        unresolvedOrders.push(id);
      }
    }
  }

  // --- Manual intents ---
  let intents: ReturnType<ManualIntentStore['allIntents']> | null = null;
  try {
    intents = inputs.manualIntents.allIntents();
  } catch (err) {
    halt(`manual intent store is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (intents) {
    for (const intent of intents.values()) {
      if (isBlockedManualStatus(intent.status) || (intent.status !== 'CANCELED' && intent.status !== 'VOID' && !isTerminalManualStatus(intent.status))) {
        unresolvedIntents.push(intent.intentId);
      }
      if (isAccountedStatus(intent.status)) {
        // ACCOUNTED but settlement evidence must exist in the live-managed portfolio.
        // Cross-file check is handled below; here we only mark the intent.
        void intent;
      }
    }
  }

  // --- Cross-file consistency (live realm) ---
  if (!halted && live.status === 'OK') {
    const reservations = (live.data as { orderReservations?: Record<string, unknown> }).orderReservations ?? {};
    // A reservation may be owned by a live-submitted order (order ledger) or a
    // manual intent. An id matching NEITHER is an orphan — a cross-file
    // contradiction that must be resolved before the realm may operate.
    const validOwners = new Set<string>();
    if (orders.status === 'OK') {
      for (const id of Object.keys(orders.data.orders)) validOwners.add(id);
    }
    if (intents) {
      for (const id of intents.keys()) validOwners.add(id);
    }
    for (const id of Object.keys(reservations)) {
      if (!validOwners.has(id)) {
        unresolvedReservations.push(id);
        crossFileIssues.push(`reservation for ${id} has no corresponding order or manual intent (orphan reservation)`);
      }
    }
  }

  // --- Manual ACCOUNTED intent must have a portfolio settlement (live realm) ---
  if (!halted && intents && live.status === 'OK') {
    const settlements = (live.data as { manualSettlements?: Record<string, unknown> }).manualSettlements ?? {};
    for (const intent of intents.values()) {
      if (isAccountedStatus(intent.status) && !(intent.intentId in settlements)) {
        unresolvedIntents.push(intent.intentId);
        crossFileIssues.push(`accounted manual intent ${intent.intentId} has no portfolio settlement`);
      }
    }
  }

  // --- Status resolution (never collapse corruption into reconciliation) ---
  if (!halted) {
    if (unresolvedOrders.length > 0 || unresolvedReservations.length > 0 || unresolvedIntents.length > 0) {
      status = 'RECONCILIATION_REQUIRED';
      requiresExchangeRead = unresolvedOrders.length > 0 || unresolvedReservations.length > 0;
      reasons.push(`${unresolvedOrders.length} unresolved order(s), ${unresolvedReservations.length} unresolved reservation(s), ${unresolvedIntents.length} unresolved intent(s)`);
    } else {
      status = 'READY';
      reasons.push('state is present and consistent');
    }
  }

  return {
    status,
    reasons,
    unresolvedOrders,
    unresolvedReservations,
    unresolvedIntents,
    crossFileIssues,
    requiresExchangeRead,
  };
}

/** Extract the LoadResult data for a store (throws on corrupt). */
export function requireOk<T>(r: LoadResult<T>): T | null {
  if (r.status === 'CORRUPT') throw new Error(`corrupt state: ${r.reason}`);
  return r.status === 'OK' ? r.data : null;
}
