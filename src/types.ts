/**
 * Core domain value types shared across the whole application.
 *
 * These are exchange-agnostic: the trading engine deals only with these types
 * and never with exchange-specific JSON. Adapters are responsible for mapping
 * exchange payloads into these models.
 */

import { Money } from './money/Money.js';

/** Fully-qualified symbol in canonical human form, e.g. "BTC/CAD". */
export type SymbolStr = string;

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Ticker {
  symbol: SymbolStr;
  /** Best bid (price), if available. */
  bid: Money | null;
  /** Best ask (price), if available. */
  ask: Money | null;
  /** Last traded price. */
  last: Money | null;
  /** The price at exchange open / reference price, if available. */
  open: Money | null;
  /** High, low, base volume, quote volume if available. */
  high: Money | null;
  low: Money | null;
  baseVolume: Money | null;
  quoteVolume: Money | null;
  /**
   * Exchange-reported quote timestamp (ms epoch), e.g. NDAX GetLevel1
   * `TimeStamp`. `null` means the exchange did NOT provide an authoritative
   * timestamp — the bot MUST NOT substitute a local time, and freshness fails
   * closed (QUOTE_MISSING). Never a fabricated `Date.now()` value.
   */
  timestampMs: number | null;
  /**
   * Local wall-clock time (ms epoch) when this snapshot was observed/fetched.
   * Stamped by the polling provider (LiveMarketData); used for transport
   * freshness checks. Absent => the risk layer fails closed on transport age.
   */
  observedAtMs?: number;
}

/** A single OHLCV candle. */
export interface Candle {
  symbol: SymbolStr;
  timeframe: Timeframe;
  /**
   * Candle END/CLOSE time (ms epoch). This matches the NDAX `GetTickerHistory`
   * `DateTime[0]` field (CCXT `parseOHLCV` convention): the candle's time is
   * stamped at its close, NOT its open. Consumers that bucket by "open time"
   * must use `timestampMs - timeframeInterval` if they need the bar start.
   */
  timestampMs: number;
  open: Money;
  high: Money;
  low: Money;
  close: Money;
  baseVolume: Money;
  quoteVolume?: Money;
  tradeCount?: number;
}

export interface OrderBookLevel {
  price: Money;
  quantity: Money;
}

export interface OrderBook {
  symbol: SymbolStr;
  /**
   * Exchange-reported quote time of the snapshot (the newest L2 `ActionDateTime`).
   * `null` when the exchange provides none — NEVER a fabricated local time.
   */
  timestampMs: number | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  /**
   * Best exchange-reported quote timestamp across the snapshot's levels,
   * e.g. the newest NDAX GetL2Snapshot `ActionDateTime`. Used (with the ticker's
   * `timestampMs`) to pick the freshest quote time for marker-data freshness.
   * Absent => the freshness check ignores it (the ticker time becomes the quote).
   */
  quoteTimestampMs?: number;
  /**
   * Local wall-clock time (ms epoch) when this snapshot was observed/fetched.
   * Stamped by the polling provider; used for transport freshness checks.
   */
  observedAtMs?: number;
}

export interface Trade {
  symbol: SymbolStr;
  /** Exchange trade id, if provided. */
  id?: string;
  price: Money;
  quantity: Money;
  /** true = buyer aggressor, false = seller aggressor, if determinable. */
  buyerIsMaker?: boolean;
  timestampMs: number;
}

/**
 * An account-level trade/fill record returned by an AUTHENTICATED read (e.g.
 * NDAX `GetAccountTrades`). This is authoritative exchange data and is
 * deliberately RICHER than the public `Trade` and the order-embedded `Fill`: it
 * carries the execution/trade ids and the fee product id, which are needed to
 * reason about exactly-once execution accounting and fee currency WITHOUT
 * fabricating an identity or assuming a currency.
 *
 * Fail-closed conventions:
 *   - `executionId`/`tradeId`/`orderId`/`clientOrderId`/`feeProductId` are only
 *     ever `null` when the exchange did NOT report them — never synthesized.
 *   - `symbol` is null when the instrument id cannot be resolved to a canonical
 *     symbol (never "guessed").
 *   - `feeProductId` is preserved VERBATIM; it is NOT coerced to 'base'/'quote'.
 */
export interface AccountTrade {
  /** Exchange execution id (e.g. NDAX `executionId`), if reported. NOT assumed unique. */
  executionId: string | null;
  /** Exchange trade id (e.g. NDAX `tradeId`), if distinct and reported. */
  tradeId: string | null;
  /** Exchange order id this execution belongs to (e.g. NDAX `orderId`). */
  orderId: string | null;
  /** Exchange client order id, if reported (NDAX documents it "may not be unique"). */
  clientOrderId: string | null;
  /** Canonical base/quote symbol resolved from the instrument id, or null. */
  symbol: string | null;
  /** Raw exchange instrument id, preserved (e.g. NDAX `instrumentId`). */
  instrumentId: string | null;
  /** Account the execution belongs to (e.g. NDAX `accountId`). */
  accountId: string | null;
  /** Sub-account, if the exchange reports one. */
  subAccountId: string | null;
  side: 'BUY' | 'SELL';
  quantity: Money;
  remainingQuantity: Money;
  price: Money;
  value: Money;
  tradeTimeMs: number | null;
  fee: Money;
  /** Exchange-defined product id for the fee asset (e.g. NDAX `feeProductId`). Verbatim. */
  feeProductId: string | null;
  /** Optional order originator (e.g. NDAX `orderOriginator`), if reported. */
  orderOriginator: string | null;
}

/** A balance entry for one currency/asset. */
export interface Balance {
  currency: string;
  total: Money;
  available: Money;
  held: Money;
}

/** Amounts and fees in the base (asset) or quote (settlement) currency. */
export interface FeeInfo {
  maker: number;
  taker: number;
  /** base/quote indicates whether fees are charged in that currency. */
  feeCurrency: 'base' | 'quote';
}

/** How the exchange classifies an asset product (e.g. NDAX `productType`). */
export type AssetProductType = 'nationalCurrency' | 'cryptoCurrency' | 'contract' | 'unknown';

/**
 * An exchange asset/product (e.g. NDAX `GetProducts`). This is the vocabulary
 * used to resolve an authoritative `feeProductId` to a real asset so a fee
 * currency can be established WITHOUT assuming base/quote.
 */
export interface AssetProduct {
  /** Exchange product id (e.g. NDAX `productId`). */
  productId: string;
  /** Exchange symbol/code for the asset (e.g. NDAX `product` = "BTC"). */
  symbol: string;
  /** Human-readable name (e.g. NDAX `productFullName`). */
  name: string;
  type: AssetProductType;
  /** Max decimal precision the exchange supports for this asset. */
  decimalPlaces: number;
  /** Optional asset tick size, if reported. */
  tickSize: string | null;
  /** True when the exchange reports this asset as fee-exempt (e.g. NDAX `noFees`). */
  noFees: boolean;
}

export interface MarketInfo {
  symbol: SymbolStr;
  /** Exchange's native identifier for this market (e.g. numeric InstrumentId). */
  exchangeId: string;
  /** Price tick size as a Money, and quantity precision (decimal places). */
  priceTick: Money;
  basePrecision: number;
  quotePrecision: number;
  /** Quantity tick size (smallest tradeable quantity increment) as Money. */
  quantityTick: Money;
  minOrderBase: Money | null;
  minOrderQuote: Money | null;
  /** Whether this market supports market orders. */
  supportsMarketOrders: boolean;
  /** Trading fees for this market, if known. */
  feeInfo: FeeInfo | null;
  /**
   * AUTHORITATIVE product metadata for the base asset (e.g. NDAX GetInstruments
   * `product1`/`product1Symbol`). Used to resolve `feeProductId` to a fee
   * currency WITHOUT parsing the symbol string. Absent when the exchange does
   * not expose it (fee-currency resolution must then fail closed).
   */
  baseProductId?: string;
  /** Authoritative product id for the quote asset (e.g. NDAX `product2`). */
  quoteProductId?: string;
  /** Authoritative base asset symbol (e.g. NDAX `product1Symbol` = "BTC"). */
  baseProductSymbol?: string;
  /** Authoritative quote asset symbol (e.g. NDAX `product2Symbol` = "CAD"). */
  quoteProductSymbol?: string;
}
