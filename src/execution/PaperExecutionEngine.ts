/**
 * PaperExecutionEngine — simulated order execution.
 *
 * This is the PAPER side of execution. It fills orders locally against a
 * reference price with configurable fees and slippage, updates the Portfolio,
 * and maintains a set of open (resting) paper orders. It has NO reference to
 * any real exchange adapter and NO path that submits a real order — calling it
 * can never touch NDAX (or any live) order placement.
 *
 * Simulation assumptions (documented in docs/DECISIONS.md):
 *   - Market orders fill fully (or by `fillFraction`) at the provided reference
 *     price, adjusted by a slippage fraction.
 *   - Limit orders fill immediately when marketable (BUY limit >= ask,
 *     SELL limit <= bid); otherwise they rest OPEN and can be cancelled. They
 *     can partial-fill by `fillFraction`.
 *   - Fees are charged as a fraction of notional, in the quote currency.
 *   - V1 is long-only: a SELL cannot exceed the held position (the risk layer
 *     sizes it, and this engine re-validates as a safety net).
 *
 * The caller is responsible for risk approval BEFORE calling submit; this
 * engine performs basic order-integrity validation only, and does not re-apply
 * portfolio-level risk limits. Reference prices are taken as already on the
 * exchange's tick; the paper engine applies no NDAX-specific assumptions.
 */

import { Money } from '../money/Money.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type {
  PaperExecutionConfig,
  PaperMarket,
  PaperOrder,
  PaperOrderRequest,
} from './PaperExecutionTypes.js';

const FRACTION_SCALE = 1_000_000_000n;

export class PaperExecutionEngine {
  private readonly cfg: PaperExecutionConfig;
  private portfolio: Portfolio;
  private readonly openOrders = new Map<string, PaperOrder>();
  private readonly allOrders: PaperOrder[] = [];
  /**
   * Durable executed-order identity restored from persisted state on restart.
   *
   * On a fresh process the in-session `allOrders` history starts empty, so this
   * set carries the previously persisted `executedOrderIds` forward. It is the
   * ONLY source of restored identity; it never fabricates order details (there
   * are no fills/prices to reconstruct from the persisted ids).
   */
  private readonly knownExecutedIds = new Set<string>();

  constructor(config: PaperExecutionConfig, portfolio: Portfolio) {
    this.cfg = config;
    this.portfolio = portfolio;
  }

  get currentPortfolio(): Portfolio {
    return this.portfolio;
  }

  get openOrderList(): PaperOrder[] {
    return [...this.openOrders.values()];
  }

  get orderHistory(): PaperOrder[] {
    return [...this.allOrders];
  }

  /**
   * Restore the durable executed-order identity after a restart. The ids come
   * from the persisted paper state (no historical details are invented); they
   * are carried forward so a subsequent save cannot silently drop them.
   */
  restoreExecutedOrderIds(ids: string[]): void {
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0) this.knownExecutedIds.add(id);
    }
  }

  /**
   * The complete set of executed order ids for persistence: the restored durable
   * ids UNION the in-session recorded orders. Order is deterministic.
   */
  get executedOrderIds(): string[] {
    const ids = new Set(this.knownExecutedIds);
    for (const o of this.allOrders) ids.add(o.clientOrderId);
    return [...ids];
  }

  /** Validate basic order integrity; return an error string or null. */
  private validateOrder(req: PaperOrderRequest, positionQty: Money): string | null {
    if (!req.quantity.isPositive()) return 'quantity must be positive';
    if (req.type === 'limit' && (!req.limitPrice || !req.limitPrice.isPositive())) {
      return 'limit order requires a positive limit price';
    }
    if (!req.symbol.includes('/')) return 'invalid symbol';
    // Long-only safety: a SELL cannot exceed the held position.
    if (req.side === 'SELL' && req.quantity.compareTo(positionQty) > 0) {
      return 'SELL quantity exceeds held position';
    }
    return null;
  }

  /** Apply slippage to a reference price for the given side. */
  private slippageAdjusted(referencePrice: Money, side: PaperOrderRequest['side']): Money {
    const factor = 1 + (side === 'BUY' ? this.cfg.slippageFraction : -this.cfg.slippageFraction);
    return exactFraction(referencePrice, factor);
  }

  /** Fraction of the order that fills this round (from `fillFraction`). */
  private fillValue(quantity: Money): Money {
    return exactFraction(quantity, this.cfg.fillFraction);
  }

  /** Fee charged on a notional (quote). */
  private feeOn(notional: Money): Money {
    return exactFraction(notional, this.cfg.feeFraction);
  }

  /**
   * True when a BUY fill's ACTUAL cost (slippage-adjusted notional + fee) would
   * consume more than the currently-deployable quote (cash minus reserved).
   *
   * C-2 invariant (accounting integrity): paper execution must NEVER spend more
   * quote than is actually available, so it can never drive paper cash negative
   * and never spend capital already reserved by another in-flight order. This is
   * enforced HERE, at the execution boundary, using the real slippage-adjusted
   * fill price and the real fee — not the reference-price approximation the risk
   * layer used to pre-approve the order. The risk layer sizes/funds at the
   * reference price; if positive slippage (or a fee model mismatch) pushes the
   * true cost past the deployable pool, the paper engine refuses the fill rather
   * than silently overdrawing or manufacturing quote currency.
   *
   * Fail-closed: an absent/missing quote map resolves to zero deployable, so any
   * positive-cost BUY is refused rather than guessed at.
   */
  private costExceedsDeployable(symbol: string, cost: Money): boolean {
    const quote = symbol.split('/')[1] ?? '';
    return cost.compareTo(this.portfolio.deployableQuote(quote)) > 0;
  }

  submitMarketOrder(req: PaperOrderRequest, market: PaperMarket, nowMs: number): PaperOrder {
    const posQty = this.portfolio.position(req.symbol)?.quantity ?? Money.zero();
    const integrityError = this.validateOrder(req, posQty);
    if (integrityError) {
      return this.rejectOrder(req, nowMs, integrityError);
    }

    const fillPrice = this.slippageAdjusted(market.referencePrice, req.side);
    const fillQty = this.fillValue(req.quantity);
    const fee = this.feeOn(fillQty.mul(fillPrice));

    // C-2: never execute a BUY whose true slippage-adjusted cost exceeds the
    // deployable quote (cash minus reserved). Refuse rather than overdraw.
    if (req.side === 'BUY' && this.costExceedsDeployable(req.symbol, fillQty.mul(fillPrice).add(fee))) {
      return this.rejectOrder(req, nowMs, 'BUY cost exceeds available quote (would overdraw cash)');
    }

    const order = this.recordOrder(
      req,
      'FILLED',
      [{ price: fillPrice, quantity: fillQty, fee, feeCurrency: 'quote', timestampMs: nowMs }],
      fillQty,
      fillPrice,
      fee,
      nowMs,
    );
    this.portfolio = this.portfolio.applyFill(req.symbol, req.side, fillQty, fillPrice, fee);
    return order;
  }

  submitLimitOrder(req: PaperOrderRequest, market: PaperMarket, nowMs: number): PaperOrder {
    const posQty = this.portfolio.position(req.symbol)?.quantity ?? Money.zero();
    const integrityError = this.validateOrder(req, posQty);
    if (integrityError) {
      return this.rejectOrder(req, nowMs, integrityError);
    }
    const limit = req.limitPrice!;

    const marketOffset = req.side === 'BUY' ? market.ask : market.bid;
    const marketable = marketOffset
      ? req.side === 'BUY'
        ? limit.compareTo(marketOffset) >= 0
        : limit.compareTo(marketOffset) <= 0
      : false;

    const fillPrice = this.slippageAdjusted(market.referencePrice, req.side);
    const fillQty = this.fillValue(req.quantity);
    const fee = this.feeOn(fillQty.mul(fillPrice));

    // C-2: never execute a BUY whose true slippage-adjusted cost exceeds the
    // deployable quote (cash minus reserved). Refuse rather than overdraw.
    if (req.side === 'BUY' && marketable && this.costExceedsDeployable(req.symbol, fillQty.mul(fillPrice).add(fee))) {
      return this.rejectOrder(req, nowMs, 'BUY cost exceeds available quote (would overdraw cash)');
    }

    if (marketable) {
      const order = this.recordOrder(
        req,
        fillQty.compareTo(req.quantity) < 0 ? 'PARTIALLY_FILLED' : 'FILLED',
        [{ price: fillPrice, quantity: fillQty, fee, feeCurrency: 'quote', timestampMs: nowMs }],
        fillQty,
        fillPrice,
        fee,
        nowMs,
      );
      this.portfolio = this.portfolio.applyFill(req.symbol, req.side, fillQty, fillPrice, fee);
      return order;
    }

    // Rest OPEN, not filled, no fee charged yet.
    const order = this.recordOrder(req, 'OPEN', [], Money.zero(), null, Money.zero(), nowMs);
    this.openOrders.set(order.clientOrderId, order);
    return order;
  }

  /** Cancel an open (resting) order. Returns null if not found / not open. */
  cancelOrder(clientOrderId: string, nowMs: number): PaperOrder | null {
    const order = this.openOrders.get(clientOrderId);
    if (!order) return null;
    order.status = 'CANCELED';
    order.updatedAtMs = nowMs;
    this.openOrders.delete(clientOrderId);
    return order;
  }

  private recordOrder(
    req: PaperOrderRequest,
    status: PaperOrder['status'],
    fills: PaperOrder['fills'],
    filledQuantity: Money,
    averagePrice: Money | null,
    fee: Money,
    nowMs: number,
  ): PaperOrder {
    const order: PaperOrder = {
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      status,
      quantity: req.quantity,
      filledQuantity,
      averagePrice,
      price: req.limitPrice ?? null,
      fills,
      fee,
      reason: req.reason,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.allOrders.push(order);
    return order;
  }

  private rejectOrder(req: PaperOrderRequest, nowMs: number, reason: string): PaperOrder {
    const order = this.recordOrder(req, 'REJECTED', [], Money.zero(), null, Money.zero(), nowMs);
    order.reason = `${req.reason} [rejected: ${reason}]`;
    return order;
  }
}

/** Exact `money * fraction` using BigInt (fraction resolved to 9 decimals). */
function exactFraction(money: Money, fraction: number): Money {
  const num = BigInt(Math.round(fraction * Number(FRACTION_SCALE)));
  return money.mulFraction(num, FRACTION_SCALE);
}
