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
/**
 * Currency in which a fee was (or may have been) charged.
 * - `base`   : charged in the base asset.
 * - `quote`  : charged in the quote (settlement) asset.
 * - `unknown`: the fee asset could NOT be authoritatively resolved (e.g. NDAX
 *   `feeProductId` present but not mapped to the instrument's base/quote, or not
 *   provided). Switching on `unknown` MUST fail closed — never assume 'quote'.
 * The adapter exposes raw `feeProductId` (via `AccountTrade`) rather than
 * pretending to know the currency; a `'quote'` value here is only ever
 * AUTHORITATIVE when resolved from exchange product metadata.
 */
export type FeeCurrency = 'base' | 'quote' | 'unknown';

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
  feeCurrency: FeeCurrency;
  /**
   * Raw exchange fee-asset id (e.g. NDAX `feeProductId`), VERBATIM. This is the
   * authoritative input for resolving `feeCurrency` via exchange product/instrument
   * metadata; it is NEVER coerced to base/quote here.
   */
  feeProductId?: string | null;
  /**
   * Exchange-reported fill timestamp (ms epoch). `null` means the exchange did
   * NOT provide an authoritative fill time — NEVER a fabricated local time.
   */
  timestampMs: number | null;
  /**
   * Immutable execution/fill identity (Gate 7.2) used for idempotent Portfolio
   * accounting. This must be a TRUSTWORTHY, exchange-derived or operator-asserted
   * unique identifier of ONE execution/fill (e.g. a trade id); it must never be
   * synthesized from price/quantity/timestamp (those do not prove exchange-level
   * uniqueness). `null`/absent means the execution cannot be safely deduplicated,
   * so `Portfolio.applyLiveFill` refuses to apply it (fail closed). Paper/backtest
   * fills leave this unset — they are applied exactly once via the non-idempotent
   * `applyFill` path, never through the live idempotent path.
   */
  executionId?: string | null;
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
  feeCurrency: FeeCurrency;
  reason: string;
  /**
   * When this order record was created. For bot-created orders this is local
   * application time; for exchange-fetched orders it is the exchange receipt
   * time when available, else `null` (unknown — never fabricated as local time).
   */
  createdAtMs: number | null;
  /** Like `createdAtMs`, the exchange's last-update time, else unknown. */
  updatedAtMs: number | null;
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
