/**
 * Action-aware pre-trade projection of a V1 reconciliation result.
 *
 * This is a PURE, read-only function: it never reads or writes exchange state,
 * never acquires the mutation lock, never commits proven executions, never
 * settles anything, and never places/cancels an order. It only decides whether a
 * SPECIFIC intended action is safe given an already-computed `ReconciliationResult`
 * from `reconcile()`.
 *
 * Why this exists (P2-1):
 *   The V1 reconciliation status is GLOBAL. In the controlled-live account there
 *   is legitimate external/unmanaged quote cash (CAD) and unrelated external
 *   assets, so the global status can be `RECONCILIATION_REQUIRED` while a bounded
 *   controlled-live SELL is still safe. Gating a SELL on `status === 'READY'`
 *   would over-block; gating it on the narrow legacy reconciler would under-block
 *   on execution/completeness/reservation/cross-domain problems. This projection
 *   applies the ownership-aware findings to the ACTION:
 *
 *   - Global hard blocks (any action): HALTED, any exchange read failure, any
 *     unresolved order, any execution that is not attributable to managed
 *     accounting (PROVEN with an unsafe/non-QUOTE fee, AMBIGUOUS, or
 *     STRONG_BUT_NOT_PROVEN), any ambiguous reservation, and any
 *     operator/cross-domain finding.
 *   - Execution attribution scope:
 *       For a SELL, UNCORRELATED executions (no local bot order attribution)
 *       do NOT independently block; they are outside managed
 *       execution-attribution scope. This is an ATTRIBUTION-SCOPING decision,
 *       NOT a claim that those executions are proven external. BUY does NOT
 *       apply this exception and remains conservative. See the execution loop
 *       below for the precise rationale and backstops.
 *   - Balance rules:
 *       SELL: a mismatch on the BASE asset being sold blocks (its ownership is
 *             what the SELL consumes). A quote-currency mismatch (e.g.
 *             external/unmanaged CAD) or unrelated-asset drift does NOT block.
 *       BUY:  a quote-currency mismatch blocks, and a positive MANAGED deployable
 *             quote is required. The exchange quote total is NEVER treated as
 *             managed cash. (BUY is not implemented/reachable; this keeps the
 *             helper semantically safe if reused.)
 *
 * Global `bot reconcile` remains strict: external/unmanaged CAD still produces
 * `RECONCILIATION_REQUIRED`. This projection does not "make reconciliation green".
 */

import type { Money } from '../money/Money.js';
import type { OrderSide } from '../order.js';
import type { ReconciliationResult } from './reconciliationTypes.js';

export interface LivePreTradeAction {
  /** The intended side. */
  side: OrderSide;
  /** The intended market, e.g. `BTC/CAD`. */
  symbol: string;
  /**
   * Quote currencies for the configured trading pairs (e.g. `{ CAD }`). Used for
   * the BUY quote-mismatch rule; a SELL ignores quote drift regardless.
   */
  quoteCurrencies: ReadonlySet<string>;
  /**
   * Managed deployable quote for the action's quote currency, from
   * `Portfolio.deployableQuoteBounded(...)`. REQUIRED for a BUY: exchange quote
   * alone is never sufficient. Ignored for a SELL.
   */
  managedQuoteDeployable?: Money;
}

export interface LivePreTradeGateResult {
  /** True only when there are no action-relevant blockers. */
  allowed: boolean;
  /** Human-readable, action-relevant reasons the action is blocked (empty if allowed). */
  blockers: string[];
}

/**
 * Project a V1 reconciliation result onto a specific intended action.
 *
 * @param result the read-only result of `reconcile()`
 * @param action the intended action (side + symbol + quote currencies)
 */
export function livePreTradeGate(
  result: ReconciliationResult,
  action: LivePreTradeAction,
): LivePreTradeGateResult {
  const blockers: string[] = [];

  // --- Global hard blocks (action-independent) ---
  if (result.status === 'HALTED') {
    blockers.push(`reconciliation HALTED: ${result.reasons.join('; ') || 'unknown'}`);
  }
  for (const f of result.readFailures) {
    blockers.push(`reconciliation read failure: ${f}`);
  }

  // Only confirmed / partially-confirmed orders may proceed. Every other
  // disposition (AMBIGUOUS, OPERATOR_REQUIRED, MISSING, CORRUPT) is unresolved.
  for (const o of result.orderFindings) {
    if (o.disposition !== 'CONFIRMED' && o.disposition !== 'PARTIALLY_CONFIRMED') {
      blockers.push(
        `order ${o.clientOrderId} is not confirmed (disposition ${o.disposition}; local ${o.localStatus}, ` +
          `exchange ${o.exchangeStatus ?? 'unknown'}, completeness ${o.completeness})`,
      );
    }
  }

  // Execution findings are gated by ATTRIBUTION to the bot's managed
  // accounting — never by a claim about external ownership:
  //   - PROVEN: correlated to a local bot order => in managed scope. It must be
  //     accounted with a QUOTE fee; a BASE/UNKNOWN/MALFORMED fee blocks.
  //   - AMBIGUOUS / STRONG_BUT_NOT_PROVEN: attribution is indeterminate (could be
  //     the bot's) => block, fail closed.
  //   - UNCORRELATED: no local bot order attribution exists. The bot does NOT
  //     account uncorrelated executions, so for a SELL they are outside managed
  //     execution-attribution scope and must not independently block. This is an
  //     ATTRIBUTION-SCOPING decision, NOT a claim that the execution is "proven
  //     external". The bot's OWN unresolved orders/reservations are separately
  //     blocked above, and the sold-base balance rule below remains the SELL
  //     backstop for external activity that changes the managed asset. BUY stays
  //     conservative: it does NOT skip UNCORRELATED executions.
  for (const e of result.executionFindings) {
    if (action.side === 'SELL' && e.correlation === 'UNCORRELATED') {
      continue;
    }

    if (e.correlation !== 'PROVEN' || e.feeDisposition !== 'QUOTE') {
      blockers.push(
        `execution ${e.executionId ?? 'no-id'} is not proven+quote (correlation ${e.correlation}, ` +
          `fee ${e.feeDisposition})`,
      );
    }
  }

  // Ambiguous reservations must block (retained, not safe to release).
  for (const r of result.reservationFindings) {
    if (r.disposition === 'AMBIGUOUS') {
      blockers.push(`reservation for ${r.orderId} is ambiguous`);
    }
  }

  // Operator / cross-domain findings are safety-relevant.
  for (const op of result.operatorFindings) {
    blockers.push(`operator finding (${op.kind}): ${op.detail}`);
  }

  // --- Action-aware balance rules ---
  const [base, quote] = action.symbol.split('/');
  if (action.side === 'SELL') {
    // Only the sold base asset's ownership is consumed by the action.
    for (const b of result.balanceFindings) {
      if (b.mismatch && b.currency === base) {
        blockers.push(`balance mismatch on sold base ${b.currency}: ${b.reason}`);
      }
    }
  } else {
    // BUY consumes managed quote; a quote mismatch means we cannot trust the
    // managed quote figure, and the exchange total must never stand in for it.
    for (const b of result.balanceFindings) {
      if (b.mismatch && (b.currency === quote || action.quoteCurrencies.has(b.currency))) {
        blockers.push(`balance mismatch on BUY quote ${b.currency}: ${b.reason}`);
      }
    }
    if (!action.managedQuoteDeployable || !action.managedQuoteDeployable.isPositive()) {
      blockers.push(
        'BUY requires a positive MANAGED deployable quote; the exchange quote total is never sufficient',
      );
    }
  }

  return { allowed: blockers.length === 0, blockers };
}
