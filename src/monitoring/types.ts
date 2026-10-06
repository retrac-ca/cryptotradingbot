/**
 * Monitoring read-model types (Stage 1 — internal read model only).
 *
 * This module defines the shape of the read-only monitoring snapshot that a
 * future HTTP API/dashboard will consume. It is a pure DATA MODEL: it contains
 * no trading logic, no execution logic, no accounting logic, and no mutation
 * surface. Every value ultimately comes from an existing authoritative source
 * (a state store, the exchange's read-only API, `reconcile()`, or config).
 *
 * SAFETY / ISOLATION:
 *   - Nothing here can place, cancel, resolve, attest, or account for an order.
 *   - PAPER, LIVE, and external/unmanaged inventory are represented SEPARATELY
 *     and are never aggregated.
 *   - Time-sensitive values carry {@link Provenance} metadata so a consumer can
 *     never mistake persisted managed state for a fresh exchange observation.
 *   - Missing data is represented as missing, corrupt data as corrupt, and
 *     stale data as stale — never silently defaulted to zero/empty/fresh.
 */

import type { ReconciliationResult } from '../reconcile/reconciliationTypes.js';

/** The origin/authority of a value in the snapshot. */
export type ValueKind =
  | 'managed_state' // read from a persisted bot state file (NOT a current exchange view)
  | 'exchange_read' // a current read-only observation from the exchange
  | 'derived' // computed from existing authoritative functions (e.g. reconciliation)
  | 'unavailable' // no source was available / no data yet
  | 'error'; // the source failed; the error is surfaced alongside

/**
 * Provenance/freshness metadata attached to a snapshot section.
 *
 * `asOfMs`    — when the underlying source produced the value (e.g. the state
 *               envelope's `savedAtMs`, or the exchange read's `checkedAtMs`).
 * `fetchedAtMs` — when the monitoring service read/observed it.
 *
 * These can legitimately differ; a consumer must use them (plus `kind`) rather
 * than treating a persisted value as a current exchange balance.
 */
export interface Provenance {
  kind: ValueKind;
  asOfMs: number | null;
  fetchedAtMs: number | null;
  stale: boolean;
  detail?: string;
}

/** Tri-state-style observation status used across sections. */
export type ObservationStatus =
  | 'OK'
  | 'MISSING'
  | 'CORRUPT'
  | 'UNAVAILABLE'
  | 'ERROR';

// ---------------------------------------------------------------------------
// System / status
// ---------------------------------------------------------------------------

/**
 * Non-secret configuration status. This is an EXPLICIT WHITELIST: the full
 * `BotConfig` (which contains NDAX credentials and account identifiers) is never
 * serialized into a snapshot.
 */
export interface SafeConfigStatus {
  version: string;
  tradingMode: 'paper' | 'live';
  exchange: string;
  killSwitch: boolean;
  enableAuthenticatedReads: boolean;
  strategy: string;
  timeframe: string;
  tradingPairs: string[];
  universeMarkets: string[];
}

export interface InitStatus {
  status: ObservationStatus;
  /** `null` when the marker is CORRUPT (unknown), never a false "not initialized". */
  paper: boolean | null;
  live: boolean | null;
  reason?: string;
}

export interface LockStatus {
  held: boolean;
}

export interface RecoveryStatusSnapshot {
  status: 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED' | 'UNAVAILABLE';
  reasons: string[];
  unresolvedOrders: string[];
  unresolvedReservations: string[];
  unresolvedIntents: string[];
  crossFileIssues: string[];
  requiresExchangeRead: boolean;
  reason?: string;
}

export interface SystemSnapshot {
  capturedAtMs: number;
  config: SafeConfigStatus;
  init: InitStatus;
  lock: LockStatus;
  recovery: RecoveryStatusSnapshot;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Portfolio (PAPER, LIVE, and external represented separately)
// ---------------------------------------------------------------------------

export interface PositionSnapshot {
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  feesPaid: string;
  entryAnchorPrice: string | null;
  source: 'BOT' | 'EXTERNAL_AUTHORIZED';
  sourceQuantities: { BOT: string; EXTERNAL_AUTHORIZED: string };
}

export interface ReservationSnapshot {
  orderId: string;
  currency: string;
  amount: string;
  remaining: string;
  status: 'ACTIVE' | 'RELEASED';
}

export interface AppliedExecutionSnapshot {
  executionId: string;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
}

export interface AttestationSnapshot {
  clientOrderId: string;
  exchangeOrderId: string;
  exchangeStatus: string;
  attestedFilledQuantity: string;
  attestedAveragePrice: string;
  fee: string;
  feeCurrency: string;
  evidenceSource: string;
  accountingAuthority: string;
  provenanceProof: false;
  operatorConfirmedBy: string;
  attestedAtMs: number;
  exchangeReadAtMs: number;
}

export interface ManualSettlementSnapshot {
  intentId: string;
  orderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  evidenceSource: string;
  exchangedValidated: boolean;
  settlementMode: string;
  provenanceProof: false;
  operatorConfirmedBy: string | null;
  executedAtMs: number | null;
  createdAtMs: number;
}

/**
 * One managed realm (paper or live). `null` fields mean "not available because
 * the realm is MISSING/CORRUPT", never "zero".
 */
export interface PortfolioRealmSnapshot {
  realm: 'paper' | 'live';
  status: ObservationStatus;
  reason?: string;
  provenance: Provenance;
  cash: Record<string, string> | null;
  positions: PositionSnapshot[] | null;
  externalSnapshot: Record<string, string> | null;
  authorizedExternal: string[] | null;
  reserved: Record<string, string> | null;
  orderReservations: ReservationSnapshot[] | null;
  appliedExecutions: AppliedExecutionSnapshot[] | null;
  liveOrderAttestations: AttestationSnapshot[] | null;
  manualSettlements: ManualSettlementSnapshot[] | null;
  peakEquity: string | null;
  realizedPnl: string | null;
  dailyRealizedPnl: string | null;
  dailyRealizedDayKey: string | null;
  totalFees: string | null;
}

/** PAPER and LIVE are kept separate and are never summed. */
export interface PortfolioSnapshot {
  paper: PortfolioRealmSnapshot;
  live: PortfolioRealmSnapshot;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface FillSnapshot {
  price: string;
  quantity: string;
  fee: string;
  feeCurrency: string;
  feeProductId: string | null;
  executionId: string | null;
  timestampMs: number | null;
}

export interface OrderResolutionSnapshot {
  kind: 'ATTACH' | 'ABANDON';
  operator: string;
  reason: string;
  resolvedAtMs: number;
  accountingAuthority: 'operator_attestation';
  provenanceProof: false;
  exchangeOrderId: string | null;
  evidence: string;
}

export interface OrderSnapshot {
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'market' | 'limit';
  status: string;
  quantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  limitPrice: string | null;
  fills: FillSnapshot[];
  fee: string;
  feeCurrency: string;
  reason: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  resolution: OrderResolutionSnapshot | null;
}

export interface OrdersSnapshot {
  status: ObservationStatus;
  reason?: string;
  provenance: Provenance;
  orders: OrderSnapshot[] | null;
  unresolvedCount: number;
  totalCount: number | null;
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  status: ObservationStatus;
  reason?: string;
  provenance: Provenance;
  symbol: string | null;
  last: string | null;
  bid: string | null;
  ask: string | null;
  spread: string | null;
  spreadPct: string | null;
  quoteTimestampMs: number | null;
  observedAtMs: number | null;
  quoteAgeMs: number | null;
  transportAgeMs: number | null;
  stale: boolean;
  staleReason: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthSnapshot {
  status: ObservationStatus;
  provenance: Provenance;
  authenticatedReadsEnabled: boolean;
  connected: boolean | null;
  latencyMs: number | null;
  detail: string | null;
  checkedAtMs: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Reconciliation (explicit, read-only, derived)
// ---------------------------------------------------------------------------

export interface ReconciliationSnapshot {
  status: 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED' | 'ERROR' | 'UNAVAILABLE';
  provenance: Provenance;
  requestedAtMs: number;
  result: ReconciliationResult | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Top-level snapshot
// ---------------------------------------------------------------------------

/**
 * A coherent read-model snapshot. It is NOT a globally transactional view:
 * state files are written atomically and individually, not as one transaction.
 * `capturedAtMs` plus per-section `provenance` timestamps let a consumer
 * understand that values may represent slightly different points in time.
 */
export interface MonitoringSnapshot {
  capturedAtMs: number;
  system: SystemSnapshot;
  portfolios: PortfolioSnapshot;
  orders: OrdersSnapshot;
  market: MarketSnapshot;
}
