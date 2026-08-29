/**
 * Execution module.
 *
 * Phase 8 provides the PAPER execution engine (simulated fills, fees, slippage,
 * cancellations) that never touches a real exchange. LIVE execution is a later
 * phase and is intentionally not present here.
 */

export { PaperExecutionEngine } from './PaperExecutionEngine.js';
export type {
  PaperOrder,
  PaperOrderRequest,
  PaperOrderStatus,
  PaperFill,
  PaperMarket,
  PaperExecutionConfig,
} from './PaperExecutionTypes.js';
