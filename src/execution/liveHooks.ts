/**
 * Shared LIVE submission hooks: the managed-state TOCTOU guard and the durable
 * managed-quote reservation used by both the controlled one-shot live-test path
 * and the autonomous LiveEngine.
 *
 * Keeping these in `execution/` lets the engine compose them without importing
 * the CLI layer. They NEVER resize, reprice, rebuild, retry, or substitute an
 * order; they only revalidate/reserve the EXACT prepared order.
 */

import { Money } from '../money/Money.js';
import type { NewOrder } from '../order.js';
import type { MarketInfo } from '../types.js';
import type { ManagedStateStore } from '../persistence/ManagedStateStore.js';
import type { ManagedOrderGuard } from './LiveExecutionEngine.js';

/** Exact `amount * fraction` via fixed-point BigInt (mirrors RiskManager). */
function fractionOfMoney(amount: Money, fraction: number): Money {
  const scale = 1_000_000_000n;
  const num = BigInt(Math.round(fraction * Number(scale)));
  return amount.mulFraction(num, scale);
}

/**
 * Mutation-boundary managed-state guard for the live path (TOCTOU).
 *
 * The live flow reads managed portfolio state, prepares the EXACT order, and
 * (for the controlled path) waits for operator confirmation. Another process
 * could mutate the durable managed state in that window. This guard is invoked
 * by the engine INSIDE the submission mutation lock, immediately before exchange
 * submission: it RELOADS the authoritative managed state and revalidates the
 * exact order against it. It performs NO mutation and NEVER resizes, reprices,
 * rebuilds, retries, or substitutes the order.
 */
export function buildManagedOrderGuard(live: ManagedStateStore): ManagedOrderGuard {
  return (order) => {
    const r = live.load();
    if (r.status === 'CORRUPT') {
      return `live managed state is corrupt (${r.reason})`;
    }
    if (r.status === 'MISSING') {
      return 'live managed state is missing at submission time (unexpected state loss)';
    }
    const portfolio = live.toPortfolio(r.data);
    if (!portfolio) {
      return 'live managed state could not be reconstructed at submission time';
    }
    if (order.side === 'SELL') {
      const managed = portfolio.position(order.symbol)?.quantity ?? Money.zero();
      if (managed.compareTo(order.quantity) < 0) {
        return (
          `managed position for ${order.symbol} is now ${managed.toString()} and no longer covers ` +
          `the approved SELL quantity ${order.quantity.toString()}; re-run live-test`
        );
      }
    }
    return null;
  };
}

/**
 * Build the durable managed-quote reservation hooks used INSIDE the engine's
 * submission mutation lock (persist-before-submit). The reservation amount is
 * the exact worst-case cost (limit notional + conservative taker fee). The hooks
 * NEVER resize/reprice; they only reserve/release exactly the prepared order.
 */
export function buildManagedQuoteReservation(args: { live: ManagedStateStore; market: MarketInfo }): {
  reserve: (order: NewOrder) => string | null;
  release: (order: NewOrder) => void;
} {
  const estimateFee = (order: NewOrder): Money => {
    const taker = args.market.feeInfo?.taker ?? 0;
    if (taker <= 0) return Money.zero();
    const notional = order.quantity.mul(order.price ?? Money.zero());
    return fractionOfMoney(notional, taker);
  };

  const reserve = (order: NewOrder): string | null => {
    const r = args.live.load();
    if (r.status === 'CORRUPT') return `live managed state is corrupt (${r.reason})`;
    if (r.status === 'MISSING') return 'live managed state is missing at submission time (unexpected state loss)';
    const portfolio = args.live.toPortfolio(r.data);
    if (!portfolio) return 'live managed state could not be reconstructed at submission time';
    const quote = order.symbol.split('/')[1] ?? '';
    const cost = order.quantity.mul(order.price ?? Money.zero()).add(estimateFee(order));
    try {
      const next = portfolio.reserveOrder(order.clientOrderId, quote, cost);
      args.live.save(next.stateModel);
    } catch (e) {
      return `could not reserve managed ${quote} for ${order.clientOrderId}: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  };

  const release = (order: NewOrder): void => {
    const r = args.live.load();
    if (r.status !== 'OK') return;
    const portfolio = args.live.toPortfolio(r.data);
    if (!portfolio) return;
    try {
      const next = portfolio.releaseOrderReservation(order.clientOrderId);
      args.live.save(next.stateModel);
    } catch {
      // Best-effort idempotent release; a failure leaves the reservation for the
      // operator/reconciliation path rather than guessing.
    }
  };

  return { reserve, release };
}
