/**
 * Reconciliation orchestrator (Reconciliation V1).
 *
 * Two explicit phases:
 *   - `reconcile()`: READ-ONLY. Captures a consistent local snapshot (brief
 *     state-directory lock), performs exchange reads (no lock), normalizes and
 *     correlates evidence, analyzes completeness/fees/balances/reservations/
 *     cross-domain, and produces an immutable `ReconciliationResult`. It NEVER
 *     mutates financial state.
 *   - `commitProven()`: the ONLY mutation path. Re-acquires the state-directory
 *     lock, reloads + re-validates state (TOCTOU), and applies ONLY PROVEN
 *     accounting via `Portfolio.applyLiveFill()` and safe reservation releases.
 *
 * No generic path silently mutates financial state.
 */

import { Money } from '../money/Money.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { OrderStore } from '../persistence/OrderStore.js';
import type { ManagedStateStore } from '../persistence/ManagedStateStore.js';
import type { ManualIntentStore } from '../manual/ManualIntentStore.js';
import { withStateDirLock, StateLockedError, CorruptStateError } from '../persistence/index.js';
import type { Order, Fill } from '../order.js';
import type { AccountTrade, Balance, MarketInfo } from '../types.js';
import { correlateExecution } from './executionCorrelation.js';
import { analyzeCompleteness } from './completeness.js';
import { resolveFeeDisposition, isFeeAutomatable } from './feeDisposition.js';
import { classifyOrder } from './orderReconciliation.js';
import { reservationDisposition } from './reservationReconciliation.js';
import { reconcileBalances } from './balanceReconciliation.js';
import { crossDomainValidation } from './crossDomain.js';
import type {
  CommitCandidate,
  ExecutionFinding,
  OperatorFinding,
  OrderFinding,
  ReconciliationResult,
  ReconciliationSnapshot,
  ReservationFinding,
  ReservationRelease,
} from './reconciliationTypes.js';
import type { ManualSettlement } from '../portfolio/types.js';

export interface ReconciliationDeps {
  stateDir: string;
  orders: OrderStore;
  live: ManagedStateStore;
  manualIntents: ManualIntentStore;
  adapter: ExchangeAdapter;
  nowMs?: () => number;
}

function empty(): ReconciliationResult {
  return {
    status: 'READY',
    reasons: [],
    readFailures: [],
    orderFindings: [],
    executionFindings: [],
    reservationFindings: [],
    balanceFindings: [],
    operatorFindings: [],
    commitCandidates: [],
    reservationReleases: [],
    canCommit: false,
  };
}

function halted(reason: string): ReconciliationResult {
  const r = empty();
  r.status = 'HALTED';
  r.reasons = [reason];
  return r;
}

/**
 * READ-ONLY reconciliation. Captures a consistent local snapshot (brief lock),
 * reads the exchange, and computes an immutable result. Never mutates state.
 */
export async function reconcile(deps: ReconciliationDeps): Promise<ReconciliationResult> {
  let snapshot: ReconciliationSnapshot;
  try {
    snapshot = withStateDirLock(deps.stateDir, () => captureSnapshot(deps));
  } catch (err) {
    if (err instanceof StateLockedError) return halted('state-directory mutation lock is held; cannot capture a consistent snapshot');
    if (err instanceof CorruptStateError) return halted(`local state corrupt: ${err.message}`);
    throw err;
  }

  const exchange = await readExchange(deps.adapter, snapshot);
  return computeFindings(snapshot, exchange);
}

/** Capture the consistent local snapshot (called under the mutation lock). */
function captureSnapshot(deps: ReconciliationDeps): ReconciliationSnapshot {
  const orders = deps.orders.allOrders(); // throws CorruptStateError on corrupt
  const liveR = deps.live.load();
  if (liveR.status === 'CORRUPT') throw new CorruptStateError(`live managed state corrupt: ${liveR.reason}`);
  const livePortfolio = liveR.status === 'OK' ? deps.live.toPortfolio(liveR.data) : null;
  const manualIntents = deps.manualIntents.allIntents();
  return {
    orders,
    livePortfolio,
    manualIntents,
    exchange: { balances: [], openOrders: [], orderHistory: [], accountTrades: [], marketInfo: new Map() },
    fetchedAtMs: deps.nowMs ? deps.nowMs() : Date.now(),
  };
}

interface ExchangeRead {
  balances: Balance[];
  openOrders: Order[];
  orderHistory: Order[];
  accountTrades: AccountTrade[];
  marketInfo: Map<string, MarketInfo>;
  readFailures: string[];
}

/** Read the exchange (no lock). Any read failure is recorded; it drives non-READY. */
async function readExchange(adapter: ExchangeAdapter, snapshot: ReconciliationSnapshot): Promise<ExchangeRead> {
  const out: ExchangeRead = {
    balances: [],
    openOrders: [],
    orderHistory: [],
    accountTrades: [],
    marketInfo: new Map(),
    readFailures: [],
  };

  const symbols = new Set<string>();
  for (const o of snapshot.orders.values()) symbols.add(o.symbol);

  try {
    out.balances = await adapter.getBalances();
  } catch (err) {
    out.readFailures.push(`getBalances failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    out.openOrders = await adapter.getOpenOrders();
  } catch (err) {
    out.readFailures.push(`getOpenOrders failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    out.orderHistory = await adapter.getOrderHistory();
  } catch (err) {
    out.readFailures.push(`getOrderHistory failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    out.accountTrades = await adapter.getAccountTrades();
  } catch (err) {
    out.readFailures.push(`getAccountTrades failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const symbol of symbols) {
    try {
      out.marketInfo.set(symbol, await adapter.getMarketInfo(symbol));
    } catch {
      // missing market info => fee resolution for this symbol fails closed (UNKNOWN).
    }
  }
  return out;
}

function computeFindings(snapshot: ReconciliationSnapshot, exchange: ExchangeRead): ReconciliationResult {
  const result = empty();
  const reasons: string[] = [];
  const operatorFindings: OperatorFinding[] = [];

  // Exchange order status keyed by normalized exchangeOrderId.
  const exchangeOrderByNorm = new Map<string, Order>();
  for (const o of [...exchange.openOrders, ...exchange.orderHistory]) {
    if (!o.exchangeOrderId) continue;
    const norm = normalizedId(o.exchangeOrderId);
    if (!exchangeOrderByNorm.has(norm)) exchangeOrderByNorm.set(norm, o);
  }

  // Correlate executions, dedupe by executionId.
  const executionFindings: ExecutionFinding[] = [];
  const commitCandidates: CommitCandidate[] = [];
  const seenExecutions = new Set<string>();
  const provenByOrder = new Map<string, Money>();

  for (const trade of exchange.accountTrades) {
    const market = trade.symbol ? exchange.marketInfo.get(trade.symbol) ?? null : null;
    const feeDisposition = resolveFeeDisposition(trade.fee, trade.feeProductId, market);
    const corr = correlateExecution(trade, snapshot.orders);

    const isDuplicate = !!trade.executionId && seenExecutions.has(trade.executionId);
    if (trade.executionId) seenExecutions.add(trade.executionId);

    const finding: ExecutionFinding = {
      executionId: trade.executionId,
      orderId: trade.orderId,
      symbol: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      fee: trade.fee,
      feeProductId: trade.feeProductId,
      feeDisposition,
      correlation: isDuplicate ? 'AMBIGUOUS' : corr.correlation,
      matchedClientOrderId: corr.matchedClientOrderId,
      completeness: 'UNKNOWN',
      reason: isDuplicate ? `duplicate executionId ${trade.executionId} returned by the exchange; deduped` : corr.reason,
    };
    executionFindings.push(finding);

    if (corr.correlation === 'PROVEN' && corr.matchedClientOrderId && isFeeAutomatable(feeDisposition)) {
      provenByOrder.set(corr.matchedClientOrderId, (provenByOrder.get(corr.matchedClientOrderId) ?? Money.zero()).add(trade.quantity));
      if (trade.executionId && trade.orderId && trade.symbol) {
        commitCandidates.push({
          clientOrderId: corr.matchedClientOrderId,
          orderId: trade.orderId,
          executionId: trade.executionId,
          symbol: trade.symbol,
          side: trade.side,
          quantity: trade.quantity,
          price: trade.price,
          fee: trade.fee,
          feeCurrency: 'quote',
        });
      }
    }
  }

  // Per-order findings + reservation findings.
  const orderFindings: OrderFinding[] = [];
  const reservationFindings: ReservationFinding[] = [];
  const reservationReleases: ReservationRelease[] = [];

  for (const [clientOrderId, order] of snapshot.orders) {
    const exchangeOrder = order.exchangeOrderId ? exchangeOrderByNorm.get(normalizedId(order.exchangeOrderId)) ?? null : null;
    const exchangeStatus = exchangeOrder?.status ?? null;
    const exchangeExecuted = exchangeOrder?.filledQuantity ?? null;
    const provenExecuted = provenByOrder.get(clientOrderId) ?? Money.zero();

    // A valid live-order operator attestation resolves THIS specific order's
    // accounting (operator-attested, provenanceProof=false). It is NEVER globally
    // equivalent to proven execution: it only affects the order for which the
    // attestation exists and matches the persisted exchangeOrderId.
    const attestation = snapshot.livePortfolio?.liveOrderAttestationsView().get(clientOrderId) ?? null;
    const hasValidAttestation =
      attestation != null &&
      attestation.attestedFilledQuantity.isPositive() &&
      order.exchangeOrderId != null &&
      attestation.exchangeOrderId != null &&
      Portfolio.sameExternalOrderId(attestation.exchangeOrderId, order.exchangeOrderId);
    const resolvedProvenExecuted = hasValidAttestation
      ? attestation!.attestedFilledQuantity
      : provenExecuted;

    const completeness = hasValidAttestation
      ? 'COMPLETE'
      : analyzeCompleteness(exchangeExecuted, provenExecuted);
    const disposition = classifyOrder({
      localStatus: order.status,
      exchangeStatus,
      exchangeExecutedQuantity: exchangeExecuted,
      provenExecuted: resolvedProvenExecuted,
      completeness,
    });
    orderFindings.push({
      clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      localStatus: order.status,
      exchangeStatus,
      disposition,
      executedQuantity: exchangeExecuted ?? order.filledQuantity,
      provenExecutedQuantity: resolvedProvenExecuted,
      completeness,
      reason: hasValidAttestation
        ? `operator-attested (provenanceProof=false): ${order.status} -> exchange ${exchangeStatus ?? 'unknown'}; disposition ${disposition}; completeness operator-attested`
        : `${order.status} -> exchange ${exchangeStatus ?? 'unknown'}; disposition ${disposition}; completeness ${completeness}`,
    });

    const hasReservation = snapshot.livePortfolio?.orderReservation(clientOrderId) != null;
    const resDisp = reservationDisposition({
      hasReservation,
      exchangeStatus,
      provenExecuted: resolvedProvenExecuted,
      accountingComplete: completeness === 'COMPLETE',
    });
    reservationFindings.push({
      orderId: clientOrderId,
      disposition: resDisp,
      reason: resDisp === 'RELEASE' ? 'confirmed terminal no-fill / complete FILLED accounting' : 'retained (not proven safe to release)',
    });
    if (resDisp === 'RELEASE') {
      reservationReleases.push({ orderId: clientOrderId, reason: 'confirmed terminal no-fill / complete FILLED accounting' });
    }

    if (disposition === 'OPERATOR_REQUIRED') {
      operatorFindings.push({
        kind: completeness === 'INCOMPLETE' ? 'OPERATOR_REQUIRED_INCOMPLETE_HISTORY' : 'OPERATOR_REQUIRED_AMBIGUOUS_ORDER',
        detail: `order ${clientOrderId} (${order.status}) cannot be finalized: completeness=${completeness}`,
      });
    }
  }

  // Balance reconciliation.
  const balanceFindings = reconcileBalances(expectedBalances(snapshot.livePortfolio), exchange.balances);

  // Cross-domain validation.
  const manualSettlements: Map<string, ManualSettlement> =
    snapshot.livePortfolio?.stateModel.manualSettlements ?? new Map<string, ManualSettlement>();
  const cross = crossDomainValidation(snapshot.orders, snapshot.livePortfolio, snapshot.manualIntents, manualSettlements);
  for (const r of cross.reasons) {
    reasons.push(r);
    operatorFindings.push({ kind: 'OPERATOR_REQUIRED_AMBIGUOUS_ORDER', detail: r });
  }
  for (const f of exchange.readFailures) reasons.push(f);

  // READY gate.
  const unresolvedExecutions = executionFindings.filter(
    (e) => e.correlation !== 'PROVEN' || e.feeDisposition !== 'QUOTE',
  ).length;
  const unresolvedOrders = orderFindings.filter((o) => o.disposition !== 'CONFIRMED' && o.disposition !== 'PARTIALLY_CONFIRMED').length;
  const unresolvedReservations = reservationFindings.filter((r) => r.disposition === 'AMBIGUOUS').length;
  const balanceMismatch = balanceFindings.some((b) => b.mismatch);
  const unresolvedCross = cross.unresolved.length > 0;

  const blocked =
    exchange.readFailures.length > 0 ||
    unresolvedExecutions > 0 ||
    unresolvedOrders > 0 ||
    unresolvedReservations > 0 ||
    balanceMismatch ||
    unresolvedCross ||
    operatorFindings.length > 0;

  result.orderFindings = orderFindings;
  result.executionFindings = executionFindings;
  result.reservationFindings = reservationFindings;
  result.balanceFindings = balanceFindings;
  result.operatorFindings = operatorFindings;
  result.commitCandidates = commitCandidates;
  result.reservationReleases = reservationReleases;
  result.canCommit = commitCandidates.length > 0;
  result.readFailures = exchange.readFailures;
  result.status = blocked ? 'RECONCILIATION_REQUIRED' : 'READY';
  result.reasons = reasons;
  return result;
}

/** Expected local managed balances: base assets (BOT + external) + quote cash. */
function expectedBalances(portfolio: Portfolio | null): Map<string, Money> {
  const out = new Map<string, Money>();
  if (!portfolio) return out;
  for (const [sym, qty] of portfolio.expectedAssetBalances()) out.set(sym, qty);
  for (const [cur, cash] of portfolio.stateModel.cash) {
    if (!out.has(cur)) out.set(cur, cash);
  }
  return out;
}

/** Normalize an exchange OrderId for keying (numeric equality). */
function normalizedId(id: string): string {
  return /^\d+$/.test(id) ? id.replace(/^0+/, '') || '0' : id;
}

/**
 * The ONLY reconciliation mutation path. Re-acquires the state-directory lock,
 * reloads + validates current state, performs TOCTOU validation, applies PROVEN
 * accounting via `Portfolio.applyLiveFill()`, releases only safe reservations,
 * and atomically persists.
 */
export function commitProven(deps: ReconciliationDeps, result: ReconciliationResult): ReconciliationResult {
  if (result.commitCandidates.length === 0 && result.reservationReleases.length === 0) {
    return result;
  }
  return withStateDirLock(deps.stateDir, () => {
    let currentOrders: Map<string, Order>;
    try {
      currentOrders = deps.orders.allOrders();
    } catch (err) {
      return halted(`order ledger corrupt during commit: ${err instanceof Error ? err.message : String(err)}`);
    }
    const liveR = deps.live.load();
    if (liveR.status === 'CORRUPT') return halted(`live managed state corrupt: ${liveR.reason}`);
    let portfolio = liveR.status === 'OK' ? deps.live.toPortfolio(liveR.data) ?? Portfolio.empty(new Map()) : Portfolio.empty(new Map());

    // TOCTOU: verify each candidate's order still matches the analyzed snapshot.
    for (const c of result.commitCandidates) {
      const current = currentOrders.get(c.clientOrderId);
      if (!current) return halted(`state changed during reconciliation: order ${c.clientOrderId} no longer exists`);
      if (current.exchangeOrderId && !Portfolio.sameExternalOrderId(current.exchangeOrderId, c.orderId)) {
        return halted(`state changed during reconciliation: order ${c.clientOrderId} now has a different exchangeOrderId`);
      }
    }

    // Apply proven executions (idempotent by executionId).
    for (const c of result.commitCandidates) {
      // An order that already has an operator attestation must NOT also receive a
      // proven-execution accounting: the two paths are mutually exclusive and
      // applying both would double-count the same real order. Fail closed.
      if (portfolio.liveOrderAttestation(c.clientOrderId)) {
        return halted(
          `order ${c.clientOrderId} already has an operator attestation; refusing to also commit a ` +
            'proven execution for it (would double-account the same exchange order)',
        );
      }
      const existing = portfolio.appliedExecution(c.executionId);
      if (existing) {
        if (
          existing.orderId !== c.clientOrderId ||
          existing.symbol !== c.symbol ||
          existing.side !== c.side ||
          !existing.quantity.equals(c.quantity) ||
          !existing.price.equals(c.price) ||
          !existing.fee.equals(c.fee)
        ) {
          return halted(`execution ${c.executionId} already applied with a conflicting payload; cannot commit`);
        }
        continue; // idempotent no-op
      }
      const fill: Fill = { price: c.price, quantity: c.quantity, fee: c.fee, feeCurrency: 'quote', timestampMs: null, executionId: c.executionId };
      // A live BUY with NO active reservation debits quote cash directly; ensure
      // it cannot overdraw the deployable pool (an active reservation is bounded
      // by applyLiveFill's consume/reservation logic instead).
      if (c.side === 'BUY') {
        const quote = c.symbol.split('/')[1] ?? '';
        const res = portfolio.orderReservation(c.clientOrderId);
        if (!res || res.status !== 'ACTIVE') {
          const cost = c.quantity.mul(c.price).add(c.fee);
          if (cost.compareTo(portfolio.deployableQuote(quote)) > 0) {
            return halted(
              `BUY execution ${c.executionId} for order ${c.clientOrderId} cost ${cost} exceeds deployable quote ` +
                `${portfolio.deployableQuote(quote)} with no active reservation; refusing to account (cash overdraw)`,
            );
          }
        }
      }
      try {
        portfolio = portfolio.applyLiveFill(c.clientOrderId, c.symbol, c.side, fill);
      } catch (err) {
        return halted(`applyLiveFill rejected execution ${c.executionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Release only safe reservations.
    for (const rel of result.reservationReleases) {
      if (portfolio.orderReservation(rel.orderId)?.status === 'ACTIVE') {
        portfolio = portfolio.releaseOrderReservation(rel.orderId);
      }
    }

    deps.live.save(portfolio.stateModel);
    return result;
  });
}
