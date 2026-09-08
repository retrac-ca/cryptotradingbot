/**
 * Execution module.
 *
 * `PaperExecutionEngine` simulates fills/fees/slippage and never touches a real
 * exchange. `LiveOrderEngine` moves fully risk-approved orders to the real
 * exchange with strict safety controls (gated start, persist-before-submit,
 * no auto-retry on ambiguous outcomes, precision/balance validation) and treats
 * the exchange as authoritative.
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
export { LiveOrderEngine, LiveGateError } from './LiveExecutionEngine.js';
export type { LiveGate, LiveExecutionConfig, LiveOrderResult, RecoveryResult } from './LiveExecutionEngine.js';
export { LiveOrderMonitor } from './LiveOrderMonitor.js';
export type { LiveOrderMonitorDeps, LiveMonitorReport, LiveMonitorTransition } from './LiveOrderMonitor.js';
export {
  createControlledLiveAuthorization,
  isControlledLiveAuthorization,
  isControlledLiveOrder,
} from './ControlledLiveAuthorization.js';
export type {
  ControlledLiveAuthorization,
  ControlledLiveScope,
} from './ControlledLiveAuthorization.js';
export { classifyReattachment, isProvableReattachmentMatch } from './recovery.js';
export type {
  ReattachmentOutcome,
  ReattachmentResult,
  ReattachmentPolicy,
} from './recovery.js';
export { evaluateLiveBuyReadiness, ndaxLiveBuyFacts } from './readiness.js';
export type {
  LiveBuyReadinessInput,
  LiveBuyReadinessReport,
  ReadinessCondition,
  ReadinessVerdict,
  ConditionStatus,
} from './readiness.js';
