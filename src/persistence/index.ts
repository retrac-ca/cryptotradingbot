/**
 * Persistence module.
 *
 * Phases 8–9 provide the minimal JSON stores required for a safe trading
 * workflow: a `PaperStateStore` that survives restarts without resetting the
 * paper portfolio, and an `OrderStore` that records every order the bot
 * attempts (keyed by clientOrderId) so duplicate submission is impossible
 * across crashes/restarts.
 */

export { PaperStateStore } from './PaperStateStore.js';
export type { PaperStateFileV1 } from './PaperStateStore.js';
export { OrderStore } from './OrderStore.js';
export type { OrderLedgerV1 } from './OrderStore.js';
