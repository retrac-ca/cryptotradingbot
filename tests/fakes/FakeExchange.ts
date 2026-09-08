/**
 * FakeExchange — an in-memory, fully configurable exchange used for unit and
 * integration testing. It NEVER contacts a real exchange and NEVER moves real
 * funds.
 *
 * It lets tests simulate:
 *   - successful orders, partial fills, cancelled orders
 *   - rejected / failed orders
 *   - network errors, timeouts
 *   - rate limiting
 *   - unknown / ambiguous order-submission outcomes (critical for testing the
 *     reconcile-before-retry safety requirement)
 *
 * Behaviours can be injected per method via the `behaviours` bag, or via a
 * reusable script. Everything financial uses the `Money` type (no floats).
 */

import { Money } from '../../src/money/Money.js';
import type {
  AccountTrade,
  Balance,
  Candle,
  MarketInfo,
  OrderBook,
  Ticker,
  Timeframe,
  Trade,
} from '../../src/types.js';
import type { NewOrder, Order, OrderStatus } from '../../src/order.js';
import type { ControlledLiveAuthorization } from '../../src/execution/ControlledLiveAuthorization.js';
import type { ExchangeAdapter, ExchangeHealth, PlaceOrderResult, CancelResult } from '../../src/exchanges/ExchangeAdapter.js';
import { ExchangeCapabilities, NO_CAPABILITIES } from '../../src/exchanges/types.js';
import {
  NetworkError,
  TimeoutError,
  RateLimitError,
  AuthenticationError,
  InvalidCredentialsError,
  OrderRejectedError,
  UnknownOrderOutcomeError,
} from '../../src/exchanges/errors.js';

export type FailureKind =
  | 'network'
  | 'timeout'
  | 'rateLimit'
  | 'auth'
  | 'invalidCredentials'
  | 'rejected'
  | 'unknownOutcome';

/** A single injected failure for a given adapter method. */
export interface FailureInjection {
  kind: FailureKind;
  once?: boolean;
}

/** What the fake should do when it receives a Market/FOK/IOC order. */
export type OrderBehavior =
  | { kind: 'fill' }
  | { kind: 'open' }
  | { kind: 'partialFill'; fillFraction: Money } // 0..1
  | { kind: 'reject'; reason?: string }
  | { kind: 'cancel' };

export interface FakeExchangeOptions {
  /** Initial balances keyed by currency code. */
  balances?: Record<string, string>;
  /** Ticker data keyed by symbol. */
  tickers?: Record<string, Partial<Ticker>>;
  /** Order books keyed by symbol. */
  orderBooks?: Record<string, OrderBook>;
  /** Candles keyed by symbol. */
  candles?: Record<string, Candle[]>;
  /** Markets keyed by symbol. */
  markets?: Record<string, Partial<MarketInfo>>;
  /** Per-method failure injections keyed by adapter method name. */
  failures?: Partial<Record<keyof ExchangeAdapter, FailureInjection>>;
  /** Behaviour for a submitted order (defaults to 'fill'). */
  orderBehavior?: OrderBehavior;
  /** That unknown order submissions should return exchangeOrderId = null. */
  unknownOrderSubmissions?: boolean;
  /** Simulated latency for every health check (ms). */
  healthLatencyMs?: number;
  /** reportGeneratedSubmittedOrders: keep a record of every placeOrder call. */
  submittedOrders?: NewOrder[];
}

export class FakeExchange implements ExchangeAdapter {
  readonly id = 'fake';
  readonly capabilities: ExchangeCapabilities = {
    supportsCandles: true,
    supportsWebSocket: false,
    supportsMarketOrders: true,
    supportsLimitOrders: true,
    supportsOrderBook: true,
    supportsFees: true,
    supportsMarketInfo: true,
    supportsOrderPlacement: true,
    publicDataRequiresAuth: false,
  };

  private balances: Map<string, Money>;
  private tickers: Map<string, Ticker>;
  private orderBooks: Map<string, OrderBook>;
  private candles: Map<string, Candle[]>;
  private markets: Map<string, MarketInfo>;
  private failures: Partial<Record<keyof ExchangeAdapter, FailureInjection>>;
  private orderBehavior: OrderBehavior;
  private unknownOrderSubmissions: boolean;
  readonly submittedOrders: NewOrder[];
  private orders: Order[] = [];
  private accountTrades: AccountTrade[] = [];
  private nextOrderId = 1;
  private nowMs: number;
  private healthLatencyMs: number;

  constructor(opts: FakeExchangeOptions = {}) {
    this.healthLatencyMs = opts.healthLatencyMs ?? 5;
    this.balances = new Map();
    for (const [cur, amt] of Object.entries(opts.balances ?? {})) {
      this.balances.set(cur, Money.fromString(amt));
    }
    this.tickers = new Map(Object.entries(opts.tickers ?? {}));
    this.orderBooks = new Map(Object.entries(opts.orderBooks ?? {}));
    this.candles = new Map(Object.entries(opts.candles ?? {}));
    this.markets = new Map(Object.entries(opts.markets ?? {}));
    this.failures = opts.failures ?? {};
    this.orderBehavior = opts.orderBehavior ?? { kind: 'fill' };
    this.unknownOrderSubmissions = opts.unknownOrderSubmissions ?? false;
    this.submittedOrders = opts.submittedOrders ?? [];
    this.nowMs = Date.now();
  }

  // ---- test helpers ----

  setBalance(currency: string, amount: string): void {
    this.balances.set(currency, Money.fromString(amount));
  }

  getBalance(currency: string): Money {
    return this.balances.get(currency) ?? Money.zero();
  }

  setTicker(symbol: string, partial: Partial<Ticker>): void {
    this.tickers.set(symbol, { symbol, bid: null, ask: null, last: null, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs: this.nowMs, ...partial });
  }

  setMarkets(ms: MarketInfo[]): void {
    for (const m of ms) this.markets.set(m.symbol, m);
  }

  setOrderBook(symbol: string, book: OrderBook): void {
    this.orderBooks.set(symbol, book);
  }

  setCandles(symbol: string, candles: Candle[]): void {
    this.candles.set(symbol, candles);
  }

  setFailures(f: Partial<Record<keyof ExchangeAdapter, FailureInjection>>): void {
    this.failures = f;
  }

  getOrders(): Order[] {
    return this.orders;
  }

  /** Directly seed the fake's order store (test helper for recovery scenarios). */
  seedOrders(orders: Order[]): void {
    this.orders = orders;
  }

  /** Directly seed the fake's authoritative account-trade store (Gate 9.2). */
  seedAccountTrades(trades: AccountTrade[]): void {
    this.accountTrades = trades;
  }

  /** Advance the fake's internal clock. */
  advanceTime(ms: number): void {
    this.nowMs += ms;
    for (const t of this.tickers.values()) t.timestampMs = this.nowMs;
  }

  // ---- injection plumbing ----

  private maybeFail(method: keyof ExchangeAdapter): void {
    const f = this.failures[method];
    if (!f) return;
    if (f.once) delete this.failures[method];
    throw makeFailure(f.kind, method);
  }

  // ---- ExchangeAdapter implementation ----

  async health(): Promise<ExchangeHealth> {
    this.maybeFail('health');
    return { connected: true, latencyMs: this.healthLatencyMs ?? 5, detail: 'fake ok', checkedAtMs: this.nowMs };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    this.maybeFail('getTicker');
    const t = this.tickers.get(symbol);
    if (!t) throw new Error(`FakeExchange: unknown symbol ${symbol}`);
    return t;
  }

  async getOrderBook(symbol: string, _depth?: number): Promise<OrderBook> {
    this.maybeFail('getOrderBook');
    const b = this.orderBooks.get(symbol);
    if (!b) throw new Error(`FakeExchange: no order book for ${symbol}`);
    return b;
  }

  async getTrades(_symbol: string, _limit?: number): Promise<Trade[]> {
    this.maybeFail('getTrades');
    return [];
  }

  async getCandles(symbol: string, _timeframe: Timeframe, _opts?: { fromMs?: number; toMs?: number; limit?: number }): Promise<Candle[]> {
    this.maybeFail('getCandles');
    return this.candles.get(symbol) ?? [];
  }

  async getBalances(): Promise<Balance[]> {
    this.maybeFail('getBalances');
    const out: Balance[] = [];
    for (const [currency, total] of this.balances) {
      out.push({ currency, total, available: total, held: Money.zero() });
    }
    return out;
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    this.maybeFail('getOpenOrders');
    return this.orders.filter((o) => (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') && (!symbol || o.symbol === symbol));
  }

  async getOrderHistory(_symbol?: string): Promise<Order[]> {
    this.maybeFail('getOrderHistory');
    return this.orders;
  }

  async getOrderStatus(_symbol: string, clientOrderId?: string, exchangeOrderId?: string): Promise<Order> {
    this.maybeFail('getOrderStatus');
    const order = this.orders.find((o) => o.clientOrderId === clientOrderId || o.exchangeOrderId === exchangeOrderId);
    if (!order) throw new Error('FakeExchange: order not found');
    return order;
  }

  async getAccountTrades(symbol?: string): Promise<AccountTrade[]> {
    this.maybeFail('getAccountTrades');
    return symbol ? this.accountTrades.filter((t) => t.symbol === symbol) : this.accountTrades;
  }

  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    this.maybeFail('getMarketInfo');
    const m = this.markets.get(symbol);
    if (!m) throw new Error(`FakeExchange: unknown market ${symbol}`);
    return m;
  }

  async getMarkets(): Promise<MarketInfo[]> {
    this.maybeFail('getMarkets');
    return [...this.markets.values()];
  }

  async placeOrder(order: NewOrder, _authorization?: ControlledLiveAuthorization): Promise<PlaceOrderResult> {
    this.maybeFail('placeOrder');
    this.submittedOrders.push(order);

    if (this.unknownOrderSubmissions) {
      // Simulate an ambiguous submission: no order id returned, order state
      // unknown. Caller must reconcile before treating it as accepted.
      return { clientOrderId: order.clientOrderId, exchangeOrderId: null, unknownOutcome: true };
    }

    const exchangeOrderId = String(this.nextOrderId++);
    const orderState: Order = {
      clientOrderId: order.clientOrderId,
      exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: 'OPEN',
      quantity: order.quantity,
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: order.price ?? null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'quote',
      reason: order.reason,
      createdAtMs: this.nowMs,
      updatedAtMs: this.nowMs,
    };
    this.orders.push(orderState);

    // Apply behavior (fill / partial / reject / cancel).
    switch (this.orderBehavior.kind) {
      case 'fill': {
        const price = this.resolvePrice(order);
        orderState.status = 'FILLED';
        orderState.filledQuantity = order.quantity;
        orderState.averagePrice = price;
        orderState.fills = [{ price, quantity: order.quantity, fee: Money.zero(), feeCurrency: 'quote', timestampMs: this.nowMs }];
        this.applySettlement(order, order.quantity, price);
        break;
      }
      case 'partialFill': {
        const price = this.resolvePrice(order);
        const filled = order.quantity.mulFraction(this.orderBehavior.fillFraction.scaled, 10n ** 8n);
        orderState.status = 'PARTIALLY_FILLED';
        orderState.filledQuantity = filled;
        orderState.averagePrice = price;
        orderState.fills = [{ price, quantity: filled, fee: Money.zero(), feeCurrency: 'quote', timestampMs: this.nowMs }];
        break;
      }
      case 'reject': {
        orderState.status = 'REJECTED';
        // Do not settle funds.
        break;
      }
      case 'open': {
        // Leave the order OPEN and un-settled.
        break;
      }
      case 'cancel': {
        orderState.status = 'CANCELED';
        break;
      }
    }
    orderState.updatedAtMs = this.nowMs;
    return { clientOrderId: order.clientOrderId, exchangeOrderId };
  }

  async cancelOrder(symbol: string, exchangeOrderId: string): Promise<CancelResult> {
    this.maybeFail('cancelOrder');
    const order = this.orders.find((o) => o.exchangeOrderId === exchangeOrderId);
    if (!order) throw new Error(`FakeExchange: order ${exchangeOrderId} not found`);
    if (order.status === 'FILLED' || order.status === 'REJECTED') {
      return { acknowledged: false, orderStatus: order.status };
    }
    order.status = 'CANCELED';
    order.updatedAtMs = this.nowMs;
    return { acknowledged: true, orderStatus: 'CANCELED' };
  }

  // ---- helpers ----

  private resolvePrice(order: NewOrder): Money {
    // For a limit order, fill at the limit price. For a market order, use the
    // best available price from the order book (or a default).
    if (order.price) return order.price;
    const book = this.orderBooks.get(order.symbol);
    if (book) {
      const levels = order.side === 'BUY' ? book.asks : book.bids;
      if (levels.length > 0) return levels[0]!.price;
    }
    return Money.fromString('100');
  }

  private applySettlement(order: NewOrder, quantity: Money, price: Money): void {
    const base = order.symbol.split('/')[0]!;
    const quote = order.symbol.split('/')[1]!;
    const value = quantity.mulFraction(price.scaled, 10n ** 8n);
    if (order.side === 'BUY') {
      const available = this.balances.get(quote) ?? Money.zero();
      this.balances.set(quote, available.sub(value));
      const baseBal = this.balances.get(base) ?? Money.zero();
      this.balances.set(base, baseBal.add(quantity));
    } else {
      const available = this.balances.get(base) ?? Money.zero();
      this.balances.set(base, available.sub(quantity));
      const quoteBal = this.balances.get(quote) ?? Money.zero();
      this.balances.set(quote, quoteBal.add(value));
    }
  }
}

export function makeFailure(kind: FailureKind, method: string): Error {
  const m = `FakeExchange[${method}]: `;
  switch (kind) {
    case 'network': return new NetworkError(m + 'simulated network failure');
    case 'timeout': return new TimeoutError(m + 'simulated timeout');
    case 'rateLimit': return new RateLimitError(m + 'simulated rate limit');
    case 'auth': return new AuthenticationError(m + 'simulated auth failure');
    case 'invalidCredentials': return new InvalidCredentialsError(m + 'simulated invalid credentials');
    case 'rejected': return new OrderRejectedError(m + 'simulated order rejection');
    case 'unknownOutcome': return new UnknownOrderOutcomeError(m + 'simulated unknown outcome');
  }
}

export { NO_CAPABILITIES };
export type { OrderStatus };
