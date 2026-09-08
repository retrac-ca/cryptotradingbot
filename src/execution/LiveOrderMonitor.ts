/**
 * LiveOrderMonitor — a bounded, read-only lifecycle observer for unresolved LIVE
 * orders (NDAX LIVE-readiness).
 *
 * RESPONSIBILITY (strictly an observer, never an execution engine):
 *   - Discover unresolved LIVE orders from the durable order ledger.
 *   - Query NDAX conservatively (existing adapter read methods only).
 *   - Advance local order state ONLY on verified exchange evidence.
 *   - Apply PROVEN executions via the existing idempotent accounting path
 *     (Portfolio.applyLiveFill), never fabricating a fill.
 *   - Release a reservation ONLY when the existing proven-terminal rules allow.
 *   - Leave uncertain states unresolved (fail-closed).
 *
 * It NEVER:
 *   - places an order (SendOrder)
 *   - cancels an order (CancelOrder)
 *   - retries an ambiguous submission
 *   - creates a replacement order
 *   - enables LIVE mode or touches `supportsOrderPlacement`
 *   - assumes aggregate executed quantity proves execution completeness
 *
 * Safety / concurrency:
 *   - Async exchange reads happen OUTSIDE the state-directory mutation lock.
 *   - All mutation (state transition + proven-fill accounting + reservation
 *     release + save) happens INSIDE the synchronous mutation lock, with a
 *     TOCTOU reload/revalidation, so it cannot race with live submission,
 *     reconciliation commit, or startup recovery.
 *   - Respects the existing NDAX REST throttle (never creates a second limiter).
 *   - Restart-safe: reads/writes only the durable OrderStore + live-managed store.
 */

import { Money } from '../money/Money.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { Order, OrderStatus, Fill } from '../order.js';
import type { AccountTrade, MarketInfo } from '../types.js';
import { OrderStore } from '../persistence/OrderStore.js';
import { ManagedStateStore } from '../persistence/ManagedStateStore.js';
import { withStateDirLock, CorruptStateError } from '../persistence/index.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import {
  correlateExecution,
  analyzeCompleteness,
  resolveFeeDisposition,
  isFeeAutomatable,
  reservationDisposition,
} from '../reconcile/index.js';

/** Live order states the monitor treats as unresolved (should be observed). */
const UNRESOLVED: ReadonlySet<OrderStatus> = new Set([
  'SUBMITTED',
  'OPEN',
  'PARTIALLY_FILLED',
  'UNKNOWN',
]);

export interface LiveMonitorTransition {
  clientOrderId: string;
  from: OrderStatus;
  to: OrderStatus;
  evidence: string;
}

export interface LiveMonitorReport {
  checkedOrders: string[];
  transitions: LiveMonitorTransition[];
  appliedExecutions: string[];
  unresolved: string[];
  releasedReservations: string[];
  errors: string[];
}

export interface LiveOrderMonitorDeps {
  /** State directory for the shared mutation lock. */
  stateDir: string;
  /** Durable order ledger (source of truth for live order state). */
  orders: OrderStore;
  /** Durable live-managed portfolio store (for reservation + fill accounting). */
  live: ManagedStateStore;
  /** Read-only exchange adapter. The monitor NEVER calls placeOrder/cancelOrder. */
  adapter: ExchangeAdapter;
  nowMs?: () => number;
}

interface OrderEvidence {
  authoritative: Order;
  executions: AccountTrade[];
  market: MarketInfo | null;
}

export class LiveOrderMonitor {
  private readonly deps: LiveOrderMonitorDeps;

  constructor(deps: LiveOrderMonitorDeps) {
    this.deps = deps;
  }

  /**
   * Run one monitor cycle. Returns a report of what was observed/advanced.
   * Read-only w.r.t. order placement/cancellation; it only persists state
   * transitions and proven-execution accounting under the mutation lock.
   */
  async monitorOnce(): Promise<LiveMonitorReport> {
    const report: LiveMonitorReport = {
      checkedOrders: [],
      transitions: [],
      appliedExecutions: [],
      unresolved: [],
      releasedReservations: [],
      errors: [],
    };

    // Phase 1 (no lock): snapshot unresolved orders and gather exchange evidence.
    const orders = this.deps.orders.allOrders();
    const unresolved = [...orders.values()].filter(
      (o) => o.clientOrderId.startsWith('live-') && UNRESOLVED.has(o.status),
    );
    if (unresolved.length === 0) return report;
    report.checkedOrders = unresolved.map((o) => o.clientOrderId);

    const evidence = new Map<string, OrderEvidence>();
    for (const order of unresolved) {
      // UNKNOWN / SUBMITTED without an exchangeOrderId cannot be reattached:
      // NDAX ClientOrderId is not proven unique. Leave it unresolved.
      if (!order.exchangeOrderId) {
        report.unresolved.push(order.clientOrderId);
        continue;
      }
      try {
        const authoritative = await this.deps.adapter.getOrderStatus(
          order.symbol,
          order.clientOrderId,
          order.exchangeOrderId,
        );
        const market = await this.safeMarketInfo(order.symbol);
        const executions = await this.safeAccountTrades(order.symbol);
        evidence.set(order.clientOrderId, { authoritative, executions, market });
      } catch (err) {
        report.errors.push(
          `${order.clientOrderId}: getOrderStatus failed (${err instanceof Error ? err.name : 'unknown'})`,
        );
      }
    }

    // Phase 2 (mutation lock): reload + TOCTOU validate + apply + save.
    return withStateDirLock(this.deps.stateDir, () => {
      const currentOrders = this.deps.orders.allOrders();
      const liveR = this.deps.live.load();
      if (liveR.status === 'CORRUPT') {
        throw new CorruptStateError(`live managed state is corrupt: ${liveR.reason}`);
      }
      let portfolio =
        liveR.status === 'OK' ? this.deps.live.toPortfolio(liveR.data) ?? Portfolio.empty(new Map()) : Portfolio.empty(new Map());
      let portfolioDirty = false;
      const appliedExecutions = new Set<string>();

      for (const order of unresolved) {
        const ev = evidence.get(order.clientOrderId);
        if (!ev) continue;
        // TOCTOU: confirm the order still exists and is still unresolved.
        const current = currentOrders.get(order.clientOrderId);
        if (!current) {
          report.errors.push(`${order.clientOrderId}: order no longer exists in the ledger`);
          continue;
        }
        if (!UNRESOLVED.has(current.status)) {
          // Already resolved by another actor; do not regress.
          continue;
        }

        // Adopt authoritative state, preserving the durable local identity.
        const updated: Order = {
          ...ev.authoritative,
          clientOrderId: current.clientOrderId,
          reason: current.reason,
          createdAtMs: current.createdAtMs,
        };
        this.deps.orders.save(updated);
        if (updated.status !== current.status) {
          report.transitions.push({
            clientOrderId: current.clientOrderId,
            from: current.status,
            to: updated.status,
            evidence: `NDAX order status reports ${updated.status}`,
          });
        }

        // Apply only PROVEN, quote-fee executions idempotently (existing path).
        let provenExecuted = Money.zero();
        for (const trade of ev.executions) {
          const corr = correlateExecution(trade, currentOrders);
          if (corr.correlation !== 'PROVEN' || corr.matchedClientOrderId !== current.clientOrderId) {
            continue;
          }
          provenExecuted = provenExecuted.add(trade.quantity);
          if (appliedExecutions.has(trade.executionId ?? '')) continue;
          // Already applied idempotently in a prior cycle => do not re-report.
          if (portfolio.appliedExecution(trade.executionId ?? '')) continue;
          const feeDisposition = resolveFeeDisposition(trade.fee, trade.feeProductId, ev.market);
          if (!isFeeAutomatable(feeDisposition)) {
            // Base/unknown/unresolved fee => never accounted here; reconciliation-required.
            continue;
          }
          const fill: Fill = {
            price: trade.price,
            quantity: trade.quantity,
            fee: trade.fee,
            feeCurrency: 'quote',
            timestampMs: trade.tradeTimeMs ?? null,
            executionId: trade.executionId,
          };
          // A live BUY with NO active reservation debits quote cash directly;
          // ensure it cannot overdraw the deployable pool (an active reservation
          // is bounded by applyLiveFill's consume/release logic instead).
          if (current.side === 'BUY') {
            const quote = current.symbol.split('/')[1] ?? '';
            const res = portfolio.orderReservation(current.clientOrderId);
            if (!res || res.status !== 'ACTIVE') {
              const cost = fill.quantity.mul(fill.price).add(fill.fee);
              if (cost.compareTo(portfolio.deployableQuote(quote)) > 0) {
                report.errors.push(
                  `${current.clientOrderId}: BUY execution ${trade.executionId} cost ${cost} exceeds deployable quote with no active reservation`,
                );
                continue;
              }
            }
          }
          try {
            portfolio = portfolio.applyLiveFill(current.clientOrderId, current.symbol, current.side, fill);
            appliedExecutions.add(trade.executionId ?? '');
            report.appliedExecutions.push(`${current.clientOrderId}:${trade.executionId}`);
            portfolioDirty = true;
          } catch {
            // Accounting-invariant failure (e.g. conflicting repeat) => fail closed.
            report.errors.push(
              `${current.clientOrderId}: applyLiveFill rejected execution ${trade.executionId}`,
            );
          }
        }

        // Reservation disposition: release only when existing rules prove it safe.
        const hasReservation = portfolio.orderReservation(current.clientOrderId) != null;
        const completeness = analyzeCompleteness(updated.filledQuantity ?? null, provenExecuted);
        const accountingComplete = completeness === 'COMPLETE';
        const resDisp = reservationDisposition({
          hasReservation,
          exchangeStatus: updated.status,
          provenExecuted,
          accountingComplete,
        });
        if (resDisp === 'RELEASE' && hasReservation) {
          portfolio = portfolio.releaseOrderReservation(current.clientOrderId);
          report.releasedReservations.push(current.clientOrderId);
          portfolioDirty = true;
        }
      }

      if (portfolioDirty) this.deps.live.save(portfolio.stateModel);
      return report;
    });
  }

  private async safeMarketInfo(symbol: string): Promise<MarketInfo | null> {
    try {
      return await this.deps.adapter.getMarketInfo(symbol);
    } catch {
      return null;
    }
  }

  private async safeAccountTrades(symbol: string): Promise<AccountTrade[]> {
    try {
      return await this.deps.adapter.getAccountTrades(symbol);
    } catch {
      return [];
    }
  }
}
