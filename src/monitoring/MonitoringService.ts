/**
 * MonitoringService — a strictly read-only read model for the dashboard.
 *
 * RESPONSIBILITY
 *   Assemble a single {@link MonitoringSnapshot} from EXISTING authoritative
 *   sources:
 *     - persisted state stores (`paper`, `live-managed`, `order-ledger`,
 *       `manual-intents`, init marker, mutation-lock presence),
 *     - the startup recovery classifier (`recoverState`),
 *     - the in-process market-data provider (if one is running),
 *     - the read-only exchange adapter (only via explicit `getHealth()`), and
 *     - the read-only reconciliation entry point (only via explicit
 *       `getReconciliation()`).
 *
 * IT NEVER
 *   - places or cancels orders (`createReadOnlyExchangeAdapter` throws on both),
 *   - creates/consumes a `ControlledLiveAuthorization`,
 *   - calls `LiveExecutionEngine`, `commitProven`, `applyLiveFill`, or
 *     `settleManualOrder`,
 *   - calls any store `save()`/mutation method,
 *   - acquires/handles the mutation lock itself, or introduces stale-lock logic,
 *   - introduces a new persistence system or a background daemon.
 *
 * This module deliberately imports only the READ side of reconciliation
 * (`reconcile`); `commitProven` is never imported or referenced.
 */

import type { BotConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { Money } from '../money/Money.js';
import type { ExchangeAdapter, ExchangeHealth } from '../exchanges/ExchangeAdapter.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import {
  evaluateFreshness,
  newestQuoteTimestampMs,
  type FreshnessPolicy,
} from '../marketdata/freshness.js';
import type { Fill, Order, OrderResolution } from '../order.js';
import type { OrderBookLevel } from '../types.js';
import type {
  LiveOrderAttestation,
  ManualSettlement,
  OrderReservation,
  PaperPosition,
  PortfolioModel,
} from '../portfolio/types.js';
import { reconcile, type ReconciliationDeps } from '../reconcile/orchestrator.js';
import {
  CorruptStateError,
  ManagedStateStore,
  OrderStore,
  PaperStateStore,
  StateInitMarker,
  isLockHeld,
  readEnvelope,
  recoverState,
} from '../persistence/index.js';
import type {
  LoadResult,
  StateDomain,
  StateRealm,
} from '../persistence/index.js';
import { ManualIntentStore } from '../manual/ManualIntentStore.js';
import { createReadOnlyExchangeAdapter } from './readOnlyAdapter.js';
import type {
  AttestationSnapshot,
  FillSnapshot,
  HealthSnapshot,
  InitStatus,
  LockStatus,
  ManualSettlementSnapshot,
  MarketSnapshot,
  MonitoringSnapshot,
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
} from './types.js';

/**
 * Order states that represent an unresolved / open live order. Mirrors the
 * non-terminal set used by `recoverState` (persistence/recovery.ts); kept local
 * so the monitoring layer does not depend on a non-exported internal constant.
 */
const UNRESOLVED_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'CREATED',
  'SUBMITTED',
  'OPEN',
  'PARTIALLY_FILLED',
  'UNKNOWN',
]);

export interface MonitoringServiceDeps {
  config: BotConfig;
  /** Application version (from `VERSION` / package.json). */
  version: string;
  orders: OrderStore;
  paper: PaperStateStore;
  live: ManagedStateStore;
  manualIntents: ManualIntentStore;
  initMarker: StateInitMarker;
  /** State directory (used only for a read-only mutation-lock presence check). */
  stateDir: string;
  /**
   * Optional in-process market-data provider. When absent, market data is
   * reported as UNAVAILABLE — the service never starts its own polling process
   * or invents values.
   */
  marketData?: MarketDataProvider | null;
  /** Market symbol to observe (defaults to the first configured trading pair). */
  marketSymbol?: string | null;
  /**
   * Optional exchange adapter. It is wrapped in a read-only facade; the raw
   * adapter is never exposed on the service. Only explicit `getHealth()` /
   * `getReconciliation()` calls use it.
   */
  adapter?: ExchangeAdapter | null;
  /** Injectable reconciliation seam for tests (defaults to the real `reconcile`). */
  reconcileFn?: typeof reconcile;
  nowMs?: () => number;
  logger?: Logger;
}

export class MonitoringService {
  private readonly deps: MonitoringServiceDeps;
  private readonly now: () => number;
  private readonly readOnlyAdapter: ExchangeAdapter | null;
  private readonly reconcileFn: typeof reconcile;
  private readonly marketSymbol: string | null;

  constructor(deps: MonitoringServiceDeps) {
    this.deps = deps;
    this.now = deps.nowMs ?? (() => Date.now());
    this.readOnlyAdapter = deps.adapter ? createReadOnlyExchangeAdapter(deps.adapter) : null;
    this.reconcileFn = deps.reconcileFn ?? reconcile;
    this.marketSymbol =
      deps.marketSymbol ?? deps.config.tradingPairs[0] ?? deps.config.universeMarkets[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Snapshot (local state + optional in-memory market data; no network calls)
  // -------------------------------------------------------------------------

  /**
   * Build a read-only snapshot from local persisted state and the optional
   * in-process market-data provider. Performs NO exchange network requests and
   * NO reconciliation; those are explicit, separately-requested operations.
   */
  async getSnapshot(): Promise<MonitoringSnapshot> {
    const capturedAtMs = this.now();
    return {
      capturedAtMs,
      system: this.buildSystem(capturedAtMs),
      portfolios: this.buildPortfolios(capturedAtMs),
      orders: this.readOrders(capturedAtMs),
      market: this.readMarket(capturedAtMs),
    };
  }

  // -------------------------------------------------------------------------
  // Explicit read-only exchange health
  // -------------------------------------------------------------------------

  /**
   * Perform ONE explicit read-only exchange health check. Never called from
   * `getSnapshot()`, so a general snapshot never incurs unnecessary exchange
   * requests. The adapter is the read-only facade (no write path).
   */
  async getHealth(): Promise<HealthSnapshot> {
    const fetchedAtMs = this.now();
    const authenticatedReadsEnabled = this.deps.config.enableAuthenticatedReads;

    if (!this.readOnlyAdapter) {
      const detail = 'no exchange adapter configured';
      return {
        status: 'UNAVAILABLE',
        provenance: provenance('unavailable', null, fetchedAtMs, false, detail),
        authenticatedReadsEnabled,
        connected: null,
        latencyMs: null,
        detail: null,
        checkedAtMs: null,
        error: detail,
      };
    }

    try {
      const health: ExchangeHealth = await this.readOnlyAdapter.health();
      return {
        status: 'OK',
        provenance: provenance('exchange_read', health.checkedAtMs, fetchedAtMs, false),
        authenticatedReadsEnabled,
        connected: health.connected,
        latencyMs: health.latencyMs,
        detail: health.detail,
        checkedAtMs: health.checkedAtMs,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'ERROR',
        provenance: provenance('error', null, fetchedAtMs, false, message),
        authenticatedReadsEnabled,
        connected: null,
        latencyMs: null,
        detail: null,
        checkedAtMs: null,
        error: message,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Explicit read-only reconciliation
  // -------------------------------------------------------------------------

  /**
   * Run the existing READ-ONLY reconciliation and return its result.
   *
   * SAFETY NOTE: `reconcile()` acquires the shared state-directory mutation lock
   * briefly to capture a CONSISTENT local snapshot, then releases it before any
   * exchange read. It performs NO mutation. Calling it concurrently with a real
   * mutator can either yield `HALTED` (if the lock is held) or briefly delay a
   * mutator; it can never turn into an accounting mutation. `commitProven()` is
   * deliberately NEVER called here.
   */
  async getReconciliation(): Promise<ReconciliationSnapshot> {
    const requestedAtMs = this.now();

    if (!this.readOnlyAdapter) {
      const detail = 'no exchange adapter configured';
      return {
        status: 'UNAVAILABLE',
        provenance: provenance('unavailable', null, requestedAtMs, false, detail),
        requestedAtMs,
        result: null,
        error: detail,
      };
    }

    try {
      const deps: ReconciliationDeps = {
        stateDir: this.deps.stateDir,
        orders: this.deps.orders,
        live: this.deps.live,
        manualIntents: this.deps.manualIntents,
        adapter: this.readOnlyAdapter,
      };
      const result = await this.reconcileFn(deps);
      return {
        status: result.status,
        provenance: provenance(
          'derived',
          requestedAtMs,
          this.now(),
          false,
          'read-only reconciliation (no accounting mutation)',
        ),
        requestedAtMs,
        result,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'ERROR',
        provenance: provenance('error', null, this.now(), false, message),
        requestedAtMs,
        result: null,
        error: message,
      };
    }
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  private buildSystem(capturedAtMs: number): SystemSnapshot {
    const initLoad = this.deps.initMarker.load();
    let init: InitStatus;
    if (initLoad.status === 'OK') {
      init = { status: 'OK', paper: initLoad.data.realms.paper, live: initLoad.data.realms.live };
    } else if (initLoad.status === 'MISSING') {
      init = { status: 'MISSING', paper: false, live: false };
    } else {
      init = { status: 'CORRUPT', paper: null, live: null, reason: initLoad.reason };
    }

    const lock: LockStatus = { held: isLockHeld(this.deps.stateDir) };

    return {
      capturedAtMs,
      config: this.safeConfigStatus(),
      init,
      lock,
      recovery: this.buildRecovery(),
      provenance: provenance('derived', capturedAtMs, capturedAtMs, false),
    };
  }

  private buildRecovery(): RecoveryStatusSnapshot {
    try {
      const report = recoverState({
        paper: this.deps.paper,
        live: this.deps.live,
        orders: this.deps.orders,
        manualIntents: this.deps.manualIntents,
        initMarker: this.deps.initMarker,
      });
      return {
        status: report.status,
        reasons: report.reasons,
        unresolvedOrders: report.unresolvedOrders,
        unresolvedReservations: report.unresolvedReservations,
        unresolvedIntents: report.unresolvedIntents,
        crossFileIssues: report.crossFileIssues,
        requiresExchangeRead: report.requiresExchangeRead,
      };
    } catch (err) {
      // recoverState is fail-closed and catches store corruption internally;
      // surface any unexpected failure explicitly rather than defaulting.
      return {
        status: 'UNAVAILABLE',
        reasons: [],
        unresolvedOrders: [],
        unresolvedReservations: [],
        unresolvedIntents: [],
        crossFileIssues: [],
        requiresExchangeRead: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * EXPLICIT non-secret whitelist. Never spreads or serializes `BotConfig`
   * (which retains NDAX credentials and account identifiers).
   */
  private safeConfigStatus(): SafeConfigStatus {
    const cfg = this.deps.config;
    return {
      version: this.deps.version,
      tradingMode: cfg.tradingMode,
      exchange: cfg.exchange,
      killSwitch: cfg.killSwitch,
      enableAuthenticatedReads: cfg.enableAuthenticatedReads,
      strategy: cfg.strategy,
      timeframe: cfg.timeframe,
      tradingPairs: [...cfg.tradingPairs],
      universeMarkets: [...cfg.universeMarkets],
    };
  }

  // -------------------------------------------------------------------------
  // Portfolio
  // -------------------------------------------------------------------------

  private buildPortfolios(fetchedAtMs: number): PortfolioSnapshot {
    return {
      paper: this.readRealm('paper', fetchedAtMs),
      live: this.readRealm('live', fetchedAtMs),
    };
  }

  private readRealm(realm: StateRealm, fetchedAtMs: number): PortfolioRealmSnapshot {
    if (realm === 'paper') {
      const load = this.deps.paper.load();
      const model = load.status === 'OK' ? this.deps.paper.toPortfolio(load.data) : null;
      return this.assembleRealm('paper', load, model, this.deps.paper.path, fetchedAtMs);
    }
    const load = this.deps.live.load();
    const recovered = load.status === 'OK' ? this.deps.live.toPortfolio(load.data) : null;
    return this.assembleRealm(
      'live',
      load,
      recovered ? recovered.stateModel : null,
      this.deps.live.path,
      fetchedAtMs,
    );
  }

  private assembleRealm(
    realm: 'paper' | 'live',
    load: LoadResult<unknown>,
    model: PortfolioModel | null,
    path: string,
    fetchedAtMs: number,
  ): PortfolioRealmSnapshot {
    if (load.status === 'MISSING') {
      return {
        realm,
        status: 'MISSING',
        reason: 'no state file (realm not initialized)',
        provenance: provenance('managed_state', null, fetchedAtMs, false, 'state file absent'),
        ...nullRealmFields(),
      };
    }
    if (load.status === 'CORRUPT') {
      return {
        realm,
        status: 'CORRUPT',
        reason: load.reason,
        provenance: provenance('managed_state', null, fetchedAtMs, false, load.reason),
        ...nullRealmFields(),
      };
    }

    const asOfMs = this.envelopeAsOf(path, realm, 'portfolio');
    const prov = provenance('managed_state', asOfMs, fetchedAtMs, false);
    if (!model) {
      return {
        realm,
        status: 'CORRUPT',
        reason: 'state failed to deserialize',
        provenance: provenance('managed_state', asOfMs, fetchedAtMs, false, 'deserialization returned null'),
        ...nullRealmFields(),
      };
    }
    return { realm, status: 'OK', provenance: prov, ...mapModelFields(model) };
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private readOrders(fetchedAtMs: number): OrdersSnapshot {
    const load = this.deps.orders.load();
    if (load.status === 'MISSING') {
      return {
        status: 'MISSING',
        reason: 'no order ledger (none recorded yet)',
        provenance: provenance('managed_state', null, fetchedAtMs, false, 'order ledger absent'),
        orders: null,
        unresolvedCount: 0,
        totalCount: null,
      };
    }
    if (load.status === 'CORRUPT') {
      return {
        status: 'CORRUPT',
        reason: load.reason,
        provenance: provenance('managed_state', null, fetchedAtMs, false, load.reason),
        orders: null,
        unresolvedCount: 0,
        totalCount: null,
      };
    }

    const asOfMs = this.envelopeAsOf(this.deps.orders.path, 'live', 'order-ledger');
    const prov = provenance('managed_state', asOfMs, fetchedAtMs, false);
    try {
      const orders = [...this.deps.orders.allOrders().values()].map(mapOrder);
      const unresolvedCount = orders.filter((o) => UNRESOLVED_ORDER_STATUSES.has(o.status)).length;
      return { status: 'OK', provenance: prov, orders, unresolvedCount, totalCount: orders.length };
    } catch (err) {
      // A corrupt ledger is surfaced as CORRUPT (never an empty success).
      if (err instanceof CorruptStateError) {
        return {
          status: 'CORRUPT',
          reason: err.message,
          provenance: provenance('managed_state', asOfMs, fetchedAtMs, false, err.message),
          orders: null,
          unresolvedCount: 0,
          totalCount: null,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'ERROR',
        reason: message,
        provenance: provenance('managed_state', asOfMs, fetchedAtMs, false, message),
        orders: null,
        unresolvedCount: 0,
        totalCount: null,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Market
  // -------------------------------------------------------------------------

  private readMarket(nowMs: number): MarketSnapshot {
    const symbol = this.marketSymbol;
    const provider = this.deps.marketData;
    if (!provider || !symbol) {
      return unavailableMarket(
        symbol,
        nowMs,
        'market data provider not running in this process',
        null,
        'unavailable',
      );
    }

    const ticker = provider.getTicker(symbol);
    const book = provider.getOrderBook(symbol);
    const lastError =
      provider.lastError('ticker', symbol) ?? provider.lastError('orderBook', symbol) ?? null;

    if (!ticker && !book) {
      return unavailableMarket(symbol, nowMs, 'no market-data snapshot available yet', lastError, 'unavailable');
    }

    const quoteTimestampMs = newestQuoteTimestampMs(ticker, book);
    const observedAtMs = ticker?.observedAtMs ?? book?.observedAtMs ?? null;
    const check = evaluateFreshness({
      nowMs,
      quoteTimestampMs,
      observedAtMs,
      policy: this.freshnessPolicy(),
    });

    const bid = ticker?.bid ?? bestPrice(book?.bids) ?? null;
    const ask = ticker?.ask ?? bestPrice(book?.asks) ?? null;
    const last = ticker?.last ?? null;
    const spread = bid && ask && ask.compareTo(bid) >= 0 ? ask.sub(bid) : null;
    const mid = bid && ask ? bid.add(ask).div(Money.fromString('2')) : null;
    const spreadPct = spread && mid && mid.isPositive() ? spread.div(mid).mulInt(100n).toString() : null;

    return {
      status: 'OK',
      provenance: provenance(
        'exchange_read',
        quoteTimestampMs,
        nowMs,
        !check.fresh,
        check.fresh ? undefined : check.reason,
      ),
      symbol,
      last: last ? last.toString() : null,
      bid: bid ? bid.toString() : null,
      ask: ask ? ask.toString() : null,
      spread: spread ? spread.toString() : null,
      spreadPct,
      quoteTimestampMs,
      observedAtMs,
      quoteAgeMs: quoteTimestampMs !== null ? nowMs - quoteTimestampMs : null,
      transportAgeMs: observedAtMs !== null ? nowMs - observedAtMs : null,
      stale: !check.fresh,
      staleReason: check.fresh ? null : check.reason,
      lastError: lastError ? lastError.message : null,
    };
  }

  private freshnessPolicy(): FreshnessPolicy {
    const cfg = this.deps.config;
    return {
      maxQuoteAgeMs: cfg.marketDataMaxAgeMs,
      maxTransportAgeMs: cfg.marketDataTransportMaxAgeMs,
      maxAcceptableFutureSkewMs: cfg.maxClockSkewMs,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Read ONLY the envelope `savedAtMs` metadata (no mutation, no interpretation). */
  private envelopeAsOf(filePath: string, realm: StateRealm, domain: StateDomain): number | null {
    const envelope = readEnvelope(filePath, realm, domain);
    return envelope.status === 'OK' ? envelope.data.savedAtMs : null;
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers (pure; no domain mutation)
// ---------------------------------------------------------------------------

function provenance(
  kind: Provenance['kind'],
  asOfMs: number | null,
  fetchedAtMs: number | null,
  stale: boolean,
  detail?: string,
): Provenance {
  return detail === undefined
    ? { kind, asOfMs, fetchedAtMs, stale }
    : { kind, asOfMs, fetchedAtMs, stale, detail };
}

function nullRealmFields(): Omit<
  PortfolioRealmSnapshot,
  'realm' | 'status' | 'reason' | 'provenance'
> {
  return {
    cash: null,
    positions: null,
    externalSnapshot: null,
    authorizedExternal: null,
    reserved: null,
    orderReservations: null,
    appliedExecutions: null,
    liveOrderAttestations: null,
    manualSettlements: null,
    peakEquity: null,
    realizedPnl: null,
    dailyRealizedPnl: null,
    dailyRealizedDayKey: null,
    totalFees: null,
  };
}

function mapModelFields(
  model: PortfolioModel,
): Omit<PortfolioRealmSnapshot, 'realm' | 'status' | 'reason' | 'provenance'> {
  return {
    cash: moneyRecord(model.cash),
    positions: [...model.positions.values()].map(mapPosition),
    externalSnapshot: moneyRecord(model.externalSnapshot),
    authorizedExternal: [...model.authorizedExternal],
    reserved: moneyRecord(model.reserved),
    orderReservations: [...model.orderReservations.values()].map(mapReservation),
    appliedExecutions: [...model.appliedExecutions.entries()].map(([executionId, a]) => ({
      executionId,
      orderId: a.orderId,
      symbol: a.symbol,
      side: a.side,
      quantity: a.quantity.toString(),
      price: a.price.toString(),
      fee: a.fee.toString(),
    })),
    liveOrderAttestations: [...model.liveOrderAttestations.values()].map(mapAttestation),
    manualSettlements: [...model.manualSettlements.values()].map(mapManualSettlement),
    peakEquity: model.peakEquity.toString(),
    realizedPnl: model.realizedPnl.toString(),
    dailyRealizedPnl: model.dailyRealizedPnl.toString(),
    dailyRealizedDayKey: model.dailyRealizedDayKey,
    totalFees: model.totalFees.toString(),
  };
}

function moneyRecord(map: ReadonlyMap<string, Money>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of map) out[key] = value.toString();
  return out;
}

function mapPosition(p: PaperPosition): PositionSnapshot {
  const sq = p.sourceQuantities ?? {
    BOT: p.source === 'BOT' ? p.quantity : Money.zero(),
    EXTERNAL_AUTHORIZED: p.source === 'EXTERNAL_AUTHORIZED' ? p.quantity : Money.zero(),
  };
  return {
    symbol: p.symbol,
    quantity: p.quantity.toString(),
    averageEntryPrice: p.averageEntryPrice.toString(),
    costBasis: p.costBasis.toString(),
    realizedPnl: p.realizedPnl.toString(),
    feesPaid: p.feesPaid.toString(),
    entryAnchorPrice: p.entryAnchorPrice ? p.entryAnchorPrice.toString() : null,
    source: p.source,
    sourceQuantities: { BOT: sq.BOT.toString(), EXTERNAL_AUTHORIZED: sq.EXTERNAL_AUTHORIZED.toString() },
  };
}

function mapReservation(r: OrderReservation): ReservationSnapshot {
  return {
    orderId: r.orderId,
    currency: r.currency,
    amount: r.amount.toString(),
    remaining: r.remaining.toString(),
    status: r.status,
  };
}

function mapAttestation(a: LiveOrderAttestation): AttestationSnapshot {
  return {
    clientOrderId: a.clientOrderId,
    exchangeOrderId: a.exchangeOrderId,
    exchangeStatus: a.exchangeStatus,
    attestedFilledQuantity: a.attestedFilledQuantity.toString(),
    attestedAveragePrice: a.attestedAveragePrice.toString(),
    fee: a.fee.toString(),
    feeCurrency: a.feeCurrency,
    evidenceSource: a.evidenceSource,
    accountingAuthority: a.accountingAuthority,
    provenanceProof: false,
    operatorConfirmedBy: a.operatorConfirmedBy,
    attestedAtMs: a.attestedAtMs,
    exchangeReadAtMs: a.exchangeReadAtMs,
  };
}

function mapManualSettlement(s: ManualSettlement): ManualSettlementSnapshot {
  return {
    intentId: s.intentId,
    orderId: s.orderId,
    symbol: s.symbol,
    side: s.side,
    quantity: s.quantity.toString(),
    price: s.price.toString(),
    fee: s.fee.toString(),
    evidenceSource: s.evidenceSource,
    exchangedValidated: s.exchangedValidated,
    settlementMode: s.settlementMode,
    provenanceProof: false,
    operatorConfirmedBy: s.operatorConfirmedBy,
    executedAtMs: s.executedAtMs,
    createdAtMs: s.createdAtMs,
  };
}

function mapOrder(o: Order): OrderSnapshot {
  return {
    clientOrderId: o.clientOrderId,
    exchangeOrderId: o.exchangeOrderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    quantity: o.quantity.toString(),
    filledQuantity: o.filledQuantity.toString(),
    averagePrice: o.averagePrice ? o.averagePrice.toString() : null,
    limitPrice: o.price ? o.price.toString() : null,
    fills: o.fills.map(mapFill),
    fee: o.fee.toString(),
    feeCurrency: o.feeCurrency,
    reason: o.reason,
    createdAtMs: o.createdAtMs,
    updatedAtMs: o.updatedAtMs,
    resolution: mapResolution(o.resolution),
  };
}

function mapFill(f: Fill): FillSnapshot {
  return {
    price: f.price.toString(),
    quantity: f.quantity.toString(),
    fee: f.fee.toString(),
    feeCurrency: f.feeCurrency,
    feeProductId: f.feeProductId ?? null,
    executionId: f.executionId ?? null,
    timestampMs: f.timestampMs,
  };
}

function mapResolution(r: OrderResolution | null | undefined): OrderResolutionSnapshot | null {
  if (!r) return null;
  return {
    kind: r.kind,
    operator: r.operator,
    reason: r.reason,
    resolvedAtMs: r.resolvedAtMs,
    accountingAuthority: 'operator_attestation',
    provenanceProof: false,
    exchangeOrderId: r.exchangeOrderId,
    evidence: r.evidence,
  };
}

function bestPrice(levels: OrderBookLevel[] | undefined): Money | null {
  if (!levels || levels.length === 0) return null;
  const top = levels[0];
  return top ? top.price : null;
}

function unavailableMarket(
  symbol: string | null,
  nowMs: number,
  reason: string,
  lastError: Error | null,
  kind: Provenance['kind'],
): MarketSnapshot {
  return {
    status: 'UNAVAILABLE',
    reason,
    provenance: provenance(kind, null, nowMs, true, lastError ? lastError.message : reason),
    symbol,
    last: null,
    bid: null,
    ask: null,
    spread: null,
    spreadPct: null,
    quoteTimestampMs: null,
    observedAtMs: null,
    quoteAgeMs: null,
    transportAgeMs: null,
    stale: true,
    staleReason: reason,
    lastError: lastError ? lastError.message : null,
  };
}
