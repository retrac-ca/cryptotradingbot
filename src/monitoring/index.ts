/**
 * Monitoring module (Stage 1 — read-only read model).
 *
 * Exposes a strictly observational `MonitoringService` and its snapshot types.
 * This module has NO HTTP server, NO frontend, NO authentication, NO operator
 * actions, and NO persistence/mutation. It only composes existing authoritative
 * read APIs (state stores, recovery, market data, read-only reconciliation) and
 * a read-only exchange adapter facade.
 */

export { MonitoringService } from './MonitoringService.js';
export type { MonitoringServiceDeps } from './MonitoringService.js';
export { createReadOnlyExchangeAdapter } from './readOnlyAdapter.js';
export type {
  AppliedExecutionSnapshot,
  AttestationSnapshot,
  FillSnapshot,
  HealthSnapshot,
  InitStatus,
  LockStatus,
  ManualSettlementSnapshot,
  MarketSnapshot,
  MonitoringSnapshot,
  ObservationStatus,
  OrderResolutionSnapshot,
  OrderSnapshot,
  OrdersSnapshot,
  PortfolioRealmSnapshot,
  PortfolioSnapshot,
  PositionSnapshot,
  Provenance,
  ReconciliationSnapshot,
  RecoveryStatusSnapshot,
  ReservationSnapshot,
  SafeConfigStatus,
  SystemSnapshot,
  ValueKind,
} from './types.js';
