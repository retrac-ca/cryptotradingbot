/**
 * Order and execution domain types.
 *
 * These describe orders in an exchange-agnostic way. The execution engine and
 * exchange adapters translate between these and their exchange-specific
 * representations. Strategies NEVER construct or place orders directly.
 */

import { Money } from './money/Money.js';
import type { SymbolStr } from './types.js';

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'market' | 'limit';
export type OrderTif = 'GTC' | 'IOC' | 'FOK';

export const ORDER_STATUS = [
  'CREATED', // locally created, not yet submitted
  'SUBMITTED', // submitted to exchange, awaiting acknowledgement
  'OPEN', // active on the book
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'UNKNOWN', // exchange state could not be determined (ambiguous)
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

export const TRADING_MODE = ['paper', 'live'] as const;
export type TradingMode = (typeof TRADING_MODE)[number];

/** A request to create an order, produced by the execution engine. */
export interface NewOrder {
  symbol: SymbolStr;
  side: OrderSide;
  type: OrderType;
  quantity: Money;
  price?: Money;
  tif?: OrderTif;
  /**
   * Locally generated unique idempotency key. The engine persists every order
   * keyed by this BEFORE submission so that a retry can never submit a
   * duplicate order. Exchange adapters must surface this to the exchange if
   * supported, otherwise the engine reconciles before retrying.
   */
  clientOrderId: string;
  /** Human reason this order exists, for auditability. */
  reason: string;
}

export interface OrderRef {
  /** Exchange-assigned order id once known. */
  exchangeOrderId: string | null;
  clientOrderId: string;
}

/** A fill against an order. */
export interface Fill {
  price: Money;
  quantity: Money;
  fee: Money;
  feeCurrency: 'base' | 'quote';
  timestampMs: number;
}

export interface Order {
  /** Local id (matches NewOrder.clientOrderId). */
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: SymbolStr;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  quantity: Money;
  filledQuantity: Money;
  /** Average fill price, once filled. */
  averagePrice: Money | null;
  price: Money | null;
  fills: Fill[];
  /** Overall order fee paid so far in the fee currency. */
  fee: Money;
  feeCurrency: 'base' | 'quote';
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Signals produced by strategies. Never executed directly. */
export interface Signal {
  symbol: SymbolStr;
  type: 'BUY' | 'SELL' | 'HOLD';
  /** Optional strategy self-reported confidence in [0,1]. */
  confidence?: number;
  /** Optional human-readable rationale for auditability. */
  reason?: string;
  timestampMs: number;
}
