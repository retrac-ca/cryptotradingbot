/**
 * Market data abstraction.
 *
 * The strategy engine consumes market data through `MarketDataProvider` — a
 * read-only, snapshot-based view that never talks to the exchange directly.
 * `LiveMarketData` (polling an `ExchangeAdapter`) is the V1 implementation;
 * historical/simulated providers (backtesting) will plug in with the same
 * interface.
 */

import type { Candle, OrderBook, Ticker, Timeframe } from '../types.js';

export type MarketDataKind = 'ticker' | 'orderBook' | 'candles';

export interface MarketDataConfig {
  /** Canonical symbols to track (e.g. ["BTC/CAD"]). */
  symbols: string[];
  /** Poll interval for tickers. 0 disables ticker polling. Default 2000ms. */
  tickerIntervalMs?: number;
  /** Poll interval for order books. 0 disables order-book polling. Default 5000ms. */
  orderBookIntervalMs?: number;
  /** Timeframes to fetch candles for. Default none (candle polling disabled). */
  candleTimeframes?: Timeframe[];
  /** Poll interval for candles. 0 disables candle polling. Default 0. */
  candleIntervalMs?: number;
  /**
   * A snapshot older than `staleAfterMs` (relative to its poll interval) is
   * reported stale by `isStale`. Default 2.5x the poll interval for that kind.
   */
  staleAfterMs?: number;
}

/** Read-only snapshot view of current market data for strategy consumption. */
export interface MarketDataProvider {
  readonly symbols: string[];
  /** Most recent ticker, or null before the first successful fetch. */
  getTicker(symbol: string): Ticker | null;
  /** Most recent order book, or null before the first successful fetch. */
  getOrderBook(symbol: string): OrderBook | null;
  /** Most recently fetched candles for a timeframe ([] before any fetch). */
  getCandles(symbol: string, timeframe: Timeframe): Candle[];
  /** True when no fresh snapshot exists for the given data kind. */
  isStale(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): boolean;
  /** Error from the most recent failed fetch, if any. */
  lastError(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): Error | null;
}

export interface MarketDataErrorEvent {
  kind: MarketDataKind;
  symbol: string;
  timeframe?: Timeframe;
  error: Error;
  consecutiveFailures: number;
}