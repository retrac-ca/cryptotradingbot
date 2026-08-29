/**
 * NDAX adapter — implements ExchangeAdapter for the retail Canadian NDAX API.
 *
 * Scope in this milestone:
 *   - Public market data (ticker, order book, candles, markets) via REST.
 *   - Authenticated account reads (balances, open orders, order history, status)
 *     using NDAX header-signing auth (Nonce/APIKey/Signature/UserId).
 *   - Order placement / cancellation are NOT enabled. They throw OrderRejectedError
 *     until explicitly enabled, so this adapter can never place a real order.
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
  mapTickerHistoryRow,
  timeframeToInterval,
  ymdhms,
} from './mappings.js';
import { ndaxSignature } from './signing.js';

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
  private readonly marketOverrides: Record<string, string>;
  private marketsCache: Map<string, MarketInfo> | null = null;
  private lastNonceMs = 0;

  constructor(opts: NdaxAdapterOptions) {
    this.creds = opts.credentials;
    this.enableAuthenticatedReads = opts.enableAuthenticatedReads ?? false;
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
    return mapL2ToOrderBook(symbol, Date.now(), data as unknown[][]);
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

  // ---- order placement (disabled) ----

  async placeOrder(_order: NewOrder): Promise<PlaceOrderResult> {
    throw new OrderRejectedError(
      'NDAX placeOrder is disabled in this milestone. Real order placement is ' +
        'not enabled and must be explicitly reviewed before use.',
    );
  }

  async cancelOrder(_symbol: string, _exchangeOrderId: string): Promise<CancelResult> {
    throw new OrderRejectedError('NDAX cancelOrder is disabled in this milestone.');
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