/**
 * Paper execution domain types.
 *
 * These describe paper orders/fills. The engine that produces them is paper-only:
 * it simulates fills locally and NEVER calls an exchange's order-placement path.
 */

import type { Money } from '../money/Money.js';
import type { OrderSide, OrderType } from '../order.js';

export type PaperOrderStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'OPEN' | 'CANCELED' | 'REJECTED';

export interface PaperFill {
  price: Money;
  quantity: Money;
  fee: Money;
  feeCurrency: 'base' | 'quote';
  timestampMs: number;
}

export interface PaperOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Money;
  /** Required for limit orders. */
  limitPrice?: Money;
  reason: string;
}

export interface PaperOrder {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: PaperOrderStatus;
  quantity: Money;
  filledQuantity: Money;
  averagePrice: Money | null;
  /** Limit price, if this is a limit order. */
  price: Money | null;
  fills: PaperFill[];
  /** Total fee paid (quote). */
  fee: Money;
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Market state an order is simulated against at submission time. */
export interface PaperMarket {
  /** Reference price for the side (ask for BUY, bid for SELL). */
  referencePrice: Money;
  /** For limit marketability checks. */
  bid: Money | null;
  ask: Money | null;
}

export interface PaperExecutionConfig {
  /** Fraction of notional charged as a fee (e.g. 0.0005 = 0.05%). */
  feeFraction: number;
  /** Fraction applied to the reference price as slippage (e.g. 0.0005). */
  slippageFraction: number;
  /**
   * Fraction of a marketable order that fills immediately (0..1).
   * 1 = full fills. Less than 1 simulates partial fills (rest stays unfilled
   * for market orders; for limits the remainder rests OPEN).
   */
  fillFraction: number;
}
