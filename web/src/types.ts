/**
 * Browser-side mirror of the Stage 2 monitoring HTTP API JSON.
 *
 * IMPORTANT: these types are deliberately DUPLICATED here rather than imported
 * from `src/`. The dashboard is a disposable presentation layer that must not
 * depend on application-domain modules. It only knows the JSON contract of the
 * read-only API. Monetary values arrive as EXACT DECIMAL STRINGS and are kept as
 * strings throughout the UI (never converted to floating point for accounting).
 */

export type ObservationStatus = 'OK' | 'MISSING' | 'CORRUPT' | 'UNAVAILABLE' | 'ERROR';

export type ValueKind =
  | 'managed_state'
  | 'exchange_read'
  | 'derived'
  | 'unavailable'
  | 'error';

export interface Provenance {
  kind: ValueKind;
  asOfMs: number | null;
  fetchedAtMs: number | null;
  stale: boolean;
  detail?: string;
}

// --- System / status --------------------------------------------------------

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
  paper: boolean | null;
  live: boolean | null;
  reason?: string;
}

export interface LockStatus {
  held: boolean;
}

export type RecoveryStatus =
  | 'READY'
  | 'RECONCILIATION_REQUIRED'
  | 'HALTED'
  | 'UNAVAILABLE';

export interface RecoveryStatusSnapshot {
  status: RecoveryStatus;
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

// --- Portfolio --------------------------------------------------------------

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

export interface PortfolioSnapshot {
  paper: PortfolioRealmSnapshot;
  live: PortfolioRealmSnapshot;
}

// --- Orders -----------------------------------------------------------------

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

// --- Market -----------------------------------------------------------------

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

// --- Health -----------------------------------------------------------------

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

// --- Reconciliation ---------------------------------------------------------

export type ReconciliationStatus =
  | 'READY'
  | 'RECONCILIATION_REQUIRED'
  | 'HALTED'
  | 'ERROR'
  | 'UNAVAILABLE';

export type CorrelationLevel =
  | 'PROVEN'
  | 'STRONG_BUT_NOT_PROVEN'
  | 'AMBIGUOUS'
  | 'UNCORRELATED';

export type Completeness = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';

export interface BalanceFinding {
  currency: string;
  expected: string | null;
  observed: string | null;
  mismatch: boolean;
  reason: string;
}

export interface OrderFinding {
  clientOrderId: string;
  exchangeOrderId: string | null;
  localStatus: string;
  exchangeStatus: string | null;
  disposition: string;
  executedQuantity: string;
  provenExecutedQuantity: string;
  completeness: Completeness;
  reason: string;
}

export interface ExecutionFinding {
  executionId: string | null;
  orderId: string | null;
  symbol: string | null;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  feeProductId: string | null;
  feeDisposition: string;
  correlation: CorrelationLevel;
  matchedClientOrderId: string | null;
  completeness: Completeness;
  reason: string;
}

export interface ReservationFinding {
  orderId: string;
  disposition: string;
  reason: string;
}

export interface OperatorFinding {
  kind: string;
  detail: string;
}

export interface ReconciliationResult {
  status: 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED';
  reasons: string[];
  readFailures: string[];
  orderFindings: OrderFinding[];
  executionFindings: ExecutionFinding[];
  reservationFindings: ReservationFinding[];
  balanceFindings: BalanceFinding[];
  operatorFindings: OperatorFinding[];
  commitCandidates: unknown[];
  reservationReleases: unknown[];
  canCommit: boolean;
}

export interface ReconciliationResponse {
  status: ReconciliationStatus;
  provenance: Provenance;
  requestedAtMs: number;
  result: ReconciliationResult | null;
  error: string | null;
}

/** Generic error envelope returned by the API for 4xx/5xx. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string };
}
