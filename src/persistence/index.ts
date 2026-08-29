/**
 * Persistence module.
 *
 * Phase 9 expands this into full SQLite-backed persistence. Phase 8 provides
 * the minimal piece required for a safe paper-trading workflow: a JSON
 * `PaperStateStore` that survives restarts without resetting the portfolio.
 */

export { PaperStateStore } from './PaperStateStore.js';
export type { PaperStateFileV1 } from './PaperStateStore.js';
