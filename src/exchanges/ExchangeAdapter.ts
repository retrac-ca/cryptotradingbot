/**
 * ExchangeAdapter — the single interface the trading engine depends on.
 *
 * The core engine NEVER imports exchange-specific (e.g. NDAX) types or classes.
 * It only talks to `ExchangeAdapter`. A concrete adapter (NDAX, and future
 * exchanges) implements this interface and maps between its exchange's native
 * wire format and the canonical domain types in `src/types.ts` / `src/order.ts`.
 *
 * Capability flags (`capabilities`) let the engine handle exchanges that don't
 * support every feature, and let adapters refuse operations safely.
 */

import type {
  AccountTrade,
  Balance,
  Candle,
  MarketInfo,
  OrderBook,
  Ticker,
  Timeframe,
  Trade,
} from '../types.js';
import type { NewOrder, Order, OrderStatus } from '../order.js';
import type { ExchangeCapabilities } from './types.js';

/** Connectivity/health of an exchange. */
export interface ExchangeHealth {
  connected: boolean;
  latencyMs: number | null;
  /** Short human-readable note explaining the state. */
  detail: string;
  checkedAtMs: number;
}

export interface PlaceOrderResult {
  /** Local idempotency key echoed back. */
  clientOrderId: string;
  /** Exchange-assigned order id if known; null if unknown (reconcile needed). */
  exchangeOrderId: string | null;
  /**
   * True when the submission outcome is ambiguous (e.g. network timeout).
   * The execution engine MUST NOT consider the order placed and MUST reconcile
   * with the exchange before any retry, to avoid duplicate orders.
   */
  unknownOutcome?: boolean;
}

export interface CancelResult {
  /** Whether the exchange confirmed the cancel request was accepted. */
  acknowledged: boolean;
  /** Resulting order status, if known. */
  orderStatus: OrderStatus | null;
}

export interface ExchangeAdapter {
  readonly id: string;
  readonly capabilities: ExchangeCapabilities;

  // ---- Connectivity / health ----
  health(): Promise<ExchangeHealth>;

  // ---- Market data ----
  getTicker(symbol: string): Promise<Ticker>;
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>;
  getTrades(symbol: string, limit?: number): Promise<Trade[]>;
  getCandles(symbol: string, timeframe: Timeframe, options?: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): Promise<Candle[]>;

  // ---- Account reads (require auth) ----
  getBalances(): Promise<Balance[]>;
  getOpenOrders(symbol?: string): Promise<Order[]>;
  getOrderHistory(symbol?: string): Promise<Order[]>;
  getOrderStatus(symbol: string, clientOrderId?: string, exchangeOrderId?: string): Promise<Order>;
  /**
   * Authoritative account trade/fill records (e.g. NDAX `GetAccountTrades`).
   * READ-ONLY. Used to reason about per-execution identity and fee currency
   * without fabricating an id or assuming a currency. Optional symbol filter
   * narrows to one market when the exchange supports it.
   */
  getAccountTrades(symbol?: string): Promise<AccountTrade[]>

  // ---- Market metadata ----
  getMarketInfo(symbol: string): Promise<MarketInfo>;
  /** Fetch all known markets. Useful for resolving symbols to exchange IDs. */
  getMarkets(): Promise<MarketInfo[]>;

  // ---- Order placement ----
  /**
   * Place an order. This must NEVER reach a real account unless the adapter is
   * explicitly configured and the caller has passed all safety checks.
   * Returns a minimal result; the actual order must be reconciled by the
   * execution engine.
   */
  placeOrder(order: NewOrder): Promise<PlaceOrderResult>;

  cancelOrder(symbol: string, exchangeOrderId: string): Promise<CancelResult>;
}

export interface OrderPlacementSafety {
  /** Whether real order submission is permitted at all. */
  allowed: boolean;
}
