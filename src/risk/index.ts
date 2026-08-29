/**
 * Risk module.
 *
 * Exposes the typed risk decisions/reason codes, the `RiskConfig` + `RiskContext`
 * lens the engine feeds in, and the `RiskManager` that turns signals into
 * approved/rejected, sized decisions.
 */

export { RISK_REASON } from './Reason.js';
export type {
  RiskReason,
  RiskDecision,
  RiskApproval,
  RiskRejection,
  AppliedRiskLimits,
} from './Reason.js';
export type { RiskConfig } from './RiskConfig.js';
export type { RiskContext } from './RiskContext.js';
export { RiskManager } from './RiskManager.js';
export { buildRiskConfig, buildRiskManager } from './buildRiskManager.js';
