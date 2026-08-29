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
  /** Exchange timestamp (ms epoch). */
  timestampMs: number;
}

/** A single OHLCV candle. */
export interface Candle {
  symbol: SymbolStr;
  timeframe: Timeframe;
  /** Candle open time (ms epoch). */
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
  timestampMs: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
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
}
