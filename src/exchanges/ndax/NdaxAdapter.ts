/**
 * NDAX adapter — implements ExchangeAdapter for the retail Canadian NDAX API.
 *
 * Scope in this milestone:
 *   - Public market data (ticker, order book, candles, markets) via REST.
 *   - Authenticated account reads (balances, open orders, order history, status)
 *     using NDAX header-signing auth (Nonce/APIKey/Signature/UserId).
 *   - Order placement / cancellation: the SendOrder/CancelOrder NETWORK PATHS are
 *     IMPLEMENTED via the shared NdaxRestClient (POST + signed headers + typed
 *     errors) and the pure orderMapper layer, but they stay DISABLED by default
 *     (`enableOrderPlacement=false`): they throw OrderRejectedError unless that
 *     internal switch is set. `capabilities.supportsOrderPlacement` remains
 *     `false`, so the live execution engine always fails closed and this adapter
 *     can never place a real order through the live path.
 *
 * Wire behavior was aligned with the production-proven CCXT NDAX connector
 * (see docs/NDAX_API.md, Phase 4): GET for reads with url-encoded query params,
 * header signing for private reads, `"YYYY-MM-DD HH:MM:SS"` FromDate/ToDate,
 * string OrderState/Side/OrderType, capitalized camelCase response keys.
 *
 * Safety: the adapter only talks to a real NDAX host if an explicit fetchImpl is
 * supplied. Tests always inject a fake, so they can never touch a live account.
 */

import { Money } from '../../money/Money.js';
import type {
  Balance,
  Candle,
  MarketInfo,
  OrderBook,
  Ticker,
  Timeframe,
  Trade,
} from '../../types.js';
import type { NewOrder, Order } from '../../order.js';
import type { ExchangeCapabilities } from '../types.js';
import type { ExchangeHealth, ExchangeAdapter, PlaceOrderResult, CancelResult } from '../ExchangeAdapter.js';
import { OrderRejectedError, AuthenticationError, ResourceNotFoundError } from '../errors.js';
import { NdaxRestClient, type FetchLike, type NdaxRestClientOptions } from './restClient.js';
import {
  mapInstrumentToMarketInfo,
  mapL2ToOrderBook,
  mapLevel1ToTicker,
  mapOrder,
  mapPositionToBalance,
  mapProduct,
  mapTickerHistoryRow,
  timeframeToInterval,
  ymdhms,
} from './mappings.js';
import { mapAccountTrades } from './tradeMappings.js';
import { resolveFeeProduct, type FeeAssetResolution } from './feeResolver.js';
import type { AccountTrade, AssetProduct } from '../../types.js';
import { mapCancelOrderResponse,
  mapSendOrderResponse,
  toNdaxCancelOrderRequest,
  toNdaxSendOrderRequest,
} from './orderMappings.js';
import { ndaxSignature } from './signing.js';
import { isControlledLiveOrder } from '../../execution/ControlledLiveAuthorization.js';
import type { ControlledLiveAuthorization } from '../../execution/ControlledLiveAuthorization.js';

export interface NdaxCredentials {
  apiKey: string;
  apiSecret: string;
  userId: string;
  /**
   * Account email (login). `GetUserAccounts` requires a `UserName`; CCXT uses
   * the login email there. Optional — if omitted an empty UserName is sent and
   * you can provide an explicit accountId instead.
   */
  userName?: string;
  /** Explicit NDAX account id; skips the GetUserAccounts lookup. */
  accountId?: number;
  /** Fixed nonce override (used by tests). When unset, a monotonic nonce is used. */
  nonce?: string;
}

export interface NdaxAdapterOptions {
  credentials: NdaxCredentials;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * If true, allow authenticated account reads. Default false. The header-
   * signing auth path is implemented to match CCXT, but it has not been verified
   * against a live account, so authenticated reads stay gated.
   */
  enableAuthenticatedReads?: boolean;
  /**
   * If true, arm the SendOrder/CancelOrder network paths. Default false. This
   * is an INTERNAL switch for deterministic wire tests ONLY — it is not exposed
   * through the bot configuration, and `capabilities.supportsOrderPlacement`
   * stays `false` regardless, so the live execution engine cannot start. It
   * exists so the exact request/response behavior can be exercised with a
   * scripted fetch without any production path reaching a real order endpoint.
   */
  enableOrderPlacement?: boolean;
  /** Minimum interval between REST requests. Defaults to the client's 1000ms. */
  throttleMs?: number;
  /** Provide instrumentId/market overrides for tests (avoids GetInstruments). */
  marketOverrides?: Record<string, string>; // canonical symbol -> instrumentId
}

const CAPABILITIES: ExchangeCapabilities = {
  supportsCandles: true,
  // The platform is WS-primary, but this adapter does not implement a WS feed
  // yet — market data is via REST polling. Kept false until a WS client exists
  // so the engine does not expect real-time events.
  supportsWebSocket: false,
  supportsMarketOrders: true,
  supportsLimitOrders: true,
  supportsOrderBook: true,
  supportsFees: true,
  supportsMarketInfo: true,
  // Deliberately kept false (Gate 2 → Gate 3): even though the SendOrder/
  // CancelOrder network paths are now implemented behind `enableOrderPlacement`,
  // the adapter does NOT advertise live placement to the engine. LiveOrderEngine
  // reads THIS flag; while it is false, live trading fails closed.
  supportsOrderPlacement: false, // NOT enabled in this milestone
  // Public data does NOT require auth (verified live: public endpoints are
  // unsigned GETs). Only account reads need credentials.
  publicDataRequiresAuth: false,
};

export class NdaxAdapter implements ExchangeAdapter {
  readonly id = 'ndax';
  readonly capabilities: ExchangeCapabilities = CAPABILITIES;

  private readonly client: NdaxRestClient;
  private readonly creds: NdaxCredentials;
  private readonly enableAuthenticatedReads: boolean;
  private readonly enableOrderPlacement: boolean;
  private readonly marketOverrides: Record<string, string>;
  private marketsCache: Map<string, MarketInfo> | null = null;
  private productsCache: AssetProduct[] | null = null;
  private lastNonceMs = 0;

  constructor(opts: NdaxAdapterOptions) {
    this.creds = opts.credentials;
    this.enableAuthenticatedReads = opts.enableAuthenticatedReads ?? false;
    this.enableOrderPlacement = opts.enableOrderPlacement ?? false;
    this.marketOverrides = opts.marketOverrides ?? {};
    const restOpts: NdaxRestClientOptions = {
      baseUrl: opts.baseUrl ?? 'https://api.ndax.io:8443/AP',
      timeoutMs: opts.timeoutMs ?? 10_000,
      headersProvider: () => (this.enableAuthenticatedReads ? this.authHeaders() : null),
    };
    if (opts.throttleMs !== undefined) restOpts.throttleMs = opts.throttleMs;
    if (opts.fetchImpl) restOpts.fetchImpl = opts.fetchImpl;
    this.client = new NdaxRestClient(restOpts);
  }

  // ---- health ----

  async health(): Promise<ExchangeHealth> {
    const start = Date.now();
    try {
      await this.client.get('Ping', { omsId: 1 });
      return { connected: true, latencyMs: Date.now() - start, detail: 'connected', checkedAtMs: Date.now() };
    } catch (err) {
      return { connected: false, latencyMs: null, detail: (err as Error).message, checkedAtMs: Date.now() };
    }
  }

  // ---- market data ----

  async getTicker(symbol: string): Promise<Ticker> {
    const instrumentId = await this.instrumentId(symbol);
    const data = await this.client.get('GetLevel1', {
      omsId: 1,
      InstrumentId: Number(instrumentId),
    });
    if (!isRecord(data)) throw new Error(`NDAX GetLevel1 returned unexpected shape for ${symbol}`);
    return mapLevel1ToTicker(symbol, data);
  }

  async getOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
    const instrumentId = await this.instrumentId(symbol);
    const data = await this.client.get('GetL2Snapshot', {
      omsId: 1,
      InstrumentId: Number(instrumentId),
      Depth: depth ?? 100,
    });
    if (!Array.isArray(data)) throw new Error(`NDAX GetL2Snapshot returned unexpected shape for ${symbol}`);
    return mapL2ToOrderBook(symbol, data as unknown[][]);
  }

  async getTrades(_symbol: string, _limit?: number): Promise<Trade[]> {
    // No public trades endpoint is confirmed on NDAX REST; return empty (cap flag
    // can gate this). Kept for interface parity.
    return [];
  }

  async getCandles(symbol: string, timeframe: Timeframe, opts?: { fromMs?: number; toMs?: number; limit?: number }): Promise<Candle[]> {
    const instrumentId = await this.instrumentId(symbol);
    const fromMs = opts?.fromMs ?? Date.now() - 24 * 3600 * 1000;
    const toMs = opts?.toMs ?? Date.now();
    const interval = timeframeToInterval(timeframe);
    const data = await this.client.get('GetTickerHistory', {
      omsId: 1,
      InstrumentId: Number(instrumentId),
      Interval: interval,
      // NDAX expects "YYYY-MM-DD HH:MM:SS" (UTC), not ISO-8601 (CCXT ymdhms).
      FromDate: ymdhms(fromMs),
      ToDate: ymdhms(toMs),
    });
    if (!Array.isArray(data)) throw new Error(`NDAX GetTickerHistory returned unexpected shape for ${symbol}`);
    const rows = data as unknown[][];
    let candles = rows.map((r) => mapTickerHistoryRow(symbol, timeframe, r));
    if (opts?.limit && candles.length > opts.limit) {
      candles = candles.slice(-opts.limit);
    }
    return candles;
  }

  // ---- account reads ----

  async getBalances(): Promise<Balance[]> {
    const auth = await this.requireAuth();
    const data = await this.client.get('GetAccountPositions', {
      omsId: 1,
      AccountId: auth.accountId,
    }, { requiresAuth: true });
    if (!Array.isArray(data)) throw new Error('NDAX GetAccountPositions returned unexpected shape');
    const balances: Balance[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const b = mapPositionToBalance(row);
      balances.push({
        currency: b.currency,
        total: b.total,
        held: b.hold,
        available: b.total.sub(b.hold),
      });
    }
    return balances;
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const auth = await this.requireAuth();
    const data = await this.client.get('GetOpenOrders', {
      omsId: 1,
      AccountId: auth.accountId,
      ...(symbol ? { InstrumentId: Number(await this.instrumentId(symbol)) } : {}),
    }, { requiresAuth: true });
    if (!Array.isArray(data)) return [];
    const resolveSymbol = await this.orderSymbolResolver();
    const orders = (data as Record<string, unknown>[]).map((o) => mapOrder(o, { resolveSymbol }));
    return symbol ? orders.filter((o) => o.symbol === symbol) : orders;
  }

  async getOrderHistory(_symbol?: string): Promise<Order[]> {
    const auth = await this.requireAuth();
    const data = await this.client.get('GetOrderHistory', {
      omsId: 1,
      AccountId: auth.accountId,
    }, { requiresAuth: true });
    if (!Array.isArray(data)) return [];
    const resolveSymbol = await this.orderSymbolResolver();
    return (data as Record<string, unknown>[]).map((o) => mapOrder(o, { resolveSymbol }));
  }

  async getOrderStatus(_symbol: string, _clientOrderId?: string, exchangeOrderId?: string): Promise<Order> {
    const auth = await this.requireAuth();
    if (!exchangeOrderId) throw new ResourceNotFoundError('NDAX getOrderStatus requires exchangeOrderId');
    const data = await this.client.get('GetOrderStatus', {
      omsId: 1,
      AccountId: auth.accountId,
      OrderId: Number(exchangeOrderId),
    }, { requiresAuth: true });
    if (!Array.isArray(data) || data.length === 0) {
      throw new ResourceNotFoundError(`NDAX order ${exchangeOrderId} not found`);
    }
    const resolveSymbol = await this.orderSymbolResolver();
    return mapOrder(data[0] as Record<string, unknown>, { resolveSymbol });
  }

  /**
   * Read the account's authoritative trade/fill records (NDAX `GetAccountTrades`).
   *
   * READ-ONLY. This exposes execution/trade ids and `feeProductId` so the manual
   * and live paths can reason about exactly-once execution accounting and fee
   * currency WITHOUT fabricating an identity or assuming a currency. Gated by
   * the same `enableAuthenticatedReads` auth as every other account read; it is
   * NEVER an order-placement call and NEVER mutates account state.
   *
   * BEST-EFFORT pagination: it pages `StartIndex` by `Count` (max 200 per page)
   * until a short page, capped at `maxPages` (10_000 executions).
   *
   * NOTE (correctness): `GetAccountTrades` has NO `orderId`/time-range filter and
   * the ordering/retention of results is NOT documented. Paging assumes a STABLE,
   * contiguous ordering; if new executions arrive between pages (shifting the
   * result window) the offsets can overlap/drift and a given order's FULL set of
   * executions is NOT guaranteed to be enumerated. Callers must therefore treat
   * the result as an observation, not a guaranteed-complete per-order set, unless
   * this is verified against the live API for their account.
   */
  async getAccountTrades(symbol?: string, opts: { maxPages?: number } = {}): Promise<AccountTrade[]> {
    const auth = await this.requireAuth();
    const maxPages = opts.maxPages ?? 50;
    const pageSize = 200;
    const resolveSymbol = await this.orderSymbolResolver();
    const all: AccountTrade[] = [];
    for (let start = 0; start < maxPages * pageSize; start += pageSize) {
      const data = await this.client.get('GetAccountTrades', {
        OMSId: 1,
        AccountId: auth.accountId,
        StartIndex: start,
        Count: pageSize,
      }, { requiresAuth: true });
      if (!Array.isArray(data) || data.length === 0) break;
      all.push(...mapAccountTrades(data, { resolveSymbol }));
      if (data.length < pageSize) break; // short page => reached the end of available records
    }
    return symbol ? all.filter((t) => t.symbol === symbol) : all;
  }

  // ---- market metadata ----

  async getMarkets(): Promise<MarketInfo[]> {
    if (this.marketsCache) return [...this.marketsCache.values()];
    const data = await this.client.get('GetInstruments', { omsId: 1 });
    if (!Array.isArray(data)) throw new Error('NDAX GetInstruments returned unexpected shape');
    const markets: MarketInfo[] = [];
    const cache = new Map<string, MarketInfo>();
    for (const row of data as Record<string, unknown>[]) {
      try {
        const m = mapInstrumentToMarketInfo(row);
        markets.push(m);
        cache.set(m.symbol, m);
      } catch {
        // skip unresolvable instruments
      }
    }
    this.marketsCache = cache;
    return markets;
  }

  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    const id = this.marketOverrides[symbol] ?? null;
    if (id) {
      // Fast path (tests / known market): build minimal MarketInfo.
      return {
        symbol,
        exchangeId: id,
        priceTick: Money.fromString('0.01'),
        basePrecision: 8,
        quotePrecision: 8,
        quantityTick: Money.fromString('0.00000001'),
        minOrderBase: null,
        minOrderQuote: null,
        supportsMarketOrders: true,
        feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
      };
    }
    const markets = await this.getMarkets();
    const m = markets.find((x) => x.symbol === symbol);
    if (!m) throw new ResourceNotFoundError(`NDAX market ${symbol} not found`);
    return m;
  }

  /**
   * Fetch the authoritative asset/product catalog (NDAX `GetProducts`). READ-ONLY.
   * Supplies the vocabulary to resolve `feeProductId` → asset symbol.
   */
  async getProducts(): Promise<AssetProduct[]> {
    if (this.productsCache) return [...this.productsCache];
    const data = await this.client.get('GetProducts', { omsId: 1 }, { requiresAuth: false });
    if (!Array.isArray(data)) return [];
    const products: AssetProduct[] = [];
    for (const row of data as Record<string, unknown>[]) {
      try {
        const p = mapProduct(row);
        if (p.productId !== '') products.push(p);
      } catch {
        // skip unresolvable products
      }
    }
    this.productsCache = products;
    return products;
  }

  /**
   * Resolve a raw `feeProductId` to an authoritative fee currency, using the
   * instrument's explicit base/quote product ids (NDAX `product1`/`product2`)
   * and the product catalog (`GetProducts`). READ-ONLY. NEVER assumes base/quote;
   * a third-asset or unknown fee yields currency 'unknown' (fail closed).
   */
  async resolveFeeCurrency(feeProductId: string | null | undefined, symbol: string): Promise<FeeAssetResolution> {
    const market = await this.getMarketInfo(symbol);
    let products: AssetProduct[] | null = null;
    try {
      products = await this.getProducts();
    } catch {
      products = null;
    }
    return resolveFeeProduct(feeProductId, { market, products });
  }

  // ---- order placement (implemented, disabled unless enableOrderPlacement) ----

  /**
   * Send the real NDAX SendOrder POST (ASYNCHRONOUS) for a fully-specified
   * NewOrder. The response only confirms RECEIPT (`{status:"Accepted"}`), NOT
   * that the order reached the book — the execution engine reconciles via
   * getOrderStatus/getOpenOrders to confirm the working order.
   *
   * Gated: throws OrderRejectedError unless `enableOrderPlacement` is true and
   * authenticated reads are enabled. `capabilities.supportsOrderPlacement`
   * stays false, so the live engine never reaches this path.
   */
  async placeOrder(order: NewOrder, authorization?: ControlledLiveAuthorization): Promise<PlaceOrderResult> {
    this.assertOrderPlacementEnabled(authorization, order);
    const auth = await this.requireAuth();
    const market = await this.getMarketInfo(order.symbol);
    const body = toNdaxSendOrderRequest(order, market, auth.accountId);
    const data = await this.client.post('SendOrder', body, { requiresAuth: true });
    const result = mapSendOrderResponse(data);
    return { ...result, clientOrderId: order.clientOrderId };
  }

  /**
   * Send the real NDAX CancelOrder POST for an exchangeOrderId. The response
   * confirms only RECEIPT, not cancellation — confirm via getOrderStatus /
   * getOpenOrders. Gated like placeOrder.
   */
  async cancelOrder(_symbol: string, exchangeOrderId: string): Promise<CancelResult> {
    this.assertOrderPlacementEnabled();
    const auth = await this.requireAuth();
    const body = toNdaxCancelOrderRequest(exchangeOrderId, auth.accountId);
    const data = await this.client.post('CancelOrder', body, { requiresAuth: true });
    return mapCancelOrderResponse(data);
  }

  // ---- private helpers ----

  private async instrumentId(symbol: string): Promise<string> {
    const override = this.marketOverrides[symbol];
    if (override) return override;
    if (this.marketsCache?.has(symbol)) {
      return this.marketsCache.get(symbol)!.exchangeId;
    }
    await this.getMarkets(); // populate cache
    const m = this.marketsCache?.get(symbol);
    if (!m) throw new ResourceNotFoundError(`NDAX market ${symbol} not found`);
    return m.exchangeId;
  }

  /** Auth headers for private reads: header-signing (CCXT pre-signIn path). */
  private authHeaders(): Record<string, string> | null {
    if (!this.creds.apiKey || !this.creds.apiSecret || !this.creds.userId) return null;
    const nonce = this.nextNonce();
    const signature = ndaxSignature(this.creds.apiSecret, nonce, this.creds.userId, this.creds.apiKey);
    return { Nonce: nonce, APIKey: this.creds.apiKey, Signature: signature, UserId: this.creds.userId };
  }

  /** Monotonic epoch-ms nonce (never repeats even within the same millisecond). */
  private nextNonce(): string {
    if (this.creds.nonce) return this.creds.nonce;
    const now = Date.now();
    const nonce = now > this.lastNonceMs ? now : this.lastNonceMs + 1;
    this.lastNonceMs = nonce;
    return String(nonce);
  }

  /** Refuse order placement unless armed, or an explicit controlled-test authorization is present. */
  private assertOrderPlacementEnabled(
    authorization?: ControlledLiveAuthorization,
    order?: NewOrder,
  ): void {
    // Existing fully-armed path (internal test switch only — never set via config).
    if (this.enableOrderPlacement) return;
    // Explicit, narrowly-scoped controlled-test authorization: SELL + LIMIT only.
    if (authorization && order && isControlledLiveOrder(order, authorization)) return;
    throw new OrderRejectedError(
      'NDAX order placement is disabled. The SendOrder/CancelOrder network ' +
        'paths are implemented but not enabled: supportsOrderPlacement remains ' +
        'false and live trading fails closed. Only the explicitly-authorized ' +
        'controlled LIMIT-only SELL test may reach SendOrder.',
    );
  }

  private async requireAuth(): Promise<{ accountId: number }> {
    if (!this.enableAuthenticatedReads) {
      throw new AuthenticationError(
        'NDAX authenticated reads are disabled (enableAuthenticatedReads=false). ' +
          'Enable it only after the auth path has been verified against a live account.',
      );
    }
    if (!this.creds.apiKey || !this.creds.apiSecret || !this.creds.userId) {
      throw new AuthenticationError('NDAX reads require apiKey, apiSecret and userId.');
    }
    let accountId = this.creds.accountId;
    if (accountId === undefined) {
      // GetUserAccounts returns a plain list of account-id integers ([449]).
      const accounts = await this.client.get('GetUserAccounts', {
        omsId: 1,
        UserId: Number(this.creds.userId),
        UserName: this.creds.userName ?? '',
      }, { requiresAuth: true });
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new ResourceNotFoundError('NDAX: no user accounts found.');
      }
      accountId = Number(accounts[0]);
      if (!Number.isFinite(accountId)) {
        throw new ResourceNotFoundError('NDAX: could not resolve accountId from GetUserAccounts.');
      }
    }
    return { accountId };
  }

  /** Resolve NDAX numeric instrument ids to canonical symbols for order rows. */
  private async orderSymbolResolver(): Promise<(instrumentId: string) => string | null> {
    const idToSymbol = new Map<string, string>();
    for (const m of await this.getMarkets()) idToSymbol.set(m.exchangeId, m.symbol);
    return (instrumentId) => idToSymbol.get(instrumentId) ?? null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}