/**
 * LiveMarketData — a polling market-data provider over an `ExchangeAdapter`.
 *
 * Fetches tickers / order books / candles on a fixed cadence, exposes the
 * latest snapshot synchronously, and emits typed events as data arrives.
 * A failed poll never throws into the caller: it records the error, emits a
 * 'failure' event, keeps the previous snapshot, and try again on the next tick.
 * (Deliberately not named 'error' — an unhandled 'error' event would throw and
 * could crash the bot; background polling must never crash the process.)
 *
 * Poll loops are deliberately conservative. The NDAX REST client already
 * throttles to >= 1 request/second globally, so intervals below about 1s give
 * no benefit and would only pile up behind the throttle.
 */

import { EventEmitter } from 'node:events';
import type { Candle, OrderBook, Ticker, Timeframe } from '../types.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type {
  MarketDataConfig,
  MarketDataErrorEvent,
  MarketDataKind,
  MarketDataProvider,
} from './types.js';

interface EventMap {
  ticker: [Ticker];
  orderBook: [OrderBook];
  candles: [Candle[]];
  failure: [MarketDataErrorEvent];
}

interface MarketDataEmitter extends EventEmitter {
  on<K extends keyof EventMap>(event: K, cb: (...args: EventMap[K]) => void): this;
  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): boolean;
}

interface Snapshot {
  data: Ticker | OrderBook | null;
  candles: Candle[] | null;
  updatedMs: number;
  error: Error | null;
  consecutiveFailures: number;
}

const DEFAULT_TICKER_MS = 2000;
const DEFAULT_ORDER_BOOK_MS = 5000;
const DEFAULT_STALE_FACTOR = 2.5;

export class LiveMarketData implements MarketDataProvider {
  readonly symbols: string[];
  readonly events: MarketDataEmitter = new EventEmitter() as MarketDataEmitter;
  private readonly adapter: ExchangeAdapter;
  private readonly tickerIntervalMs: number;
  private readonly orderBookIntervalMs: number;
  private readonly candleIntervalMs: number;
  private readonly candleTimeframes: Timeframe[];
  private readonly staleAfterMs: number;
  private readonly state = new Map<string, Snapshot>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(adapter: ExchangeAdapter, config: MarketDataConfig) {
    this.adapter = adapter;
    this.symbols = [...config.symbols];
    this.tickerIntervalMs = config.tickerIntervalMs ?? DEFAULT_TICKER_MS;
    this.orderBookIntervalMs = config.orderBookIntervalMs ?? DEFAULT_ORDER_BOOK_MS;
    this.candleIntervalMs = config.candleIntervalMs ?? 0;
    this.candleTimeframes = config.candleTimeframes ?? [];
    this.staleAfterMs = config.staleAfterMs ?? Number.POSITIVE_INFINITY;
  }

  // ---- lifecycle ----

  /**
   * Fetch an initial snapshot for every configured symbol/kinds, then start the
   * polling loops. Initial fetches run sequentially to keep request pressure
   * low (in particular behind the adapter's own throttle).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const symbol of this.symbols) {
      if (this.tickerIntervalMs > 0) await this.poll('ticker', symbol);
    }
    for (const symbol of this.symbols) {
      if (this.orderBookIntervalMs > 0) await this.poll('orderBook', symbol);
    }
    for (const tf of this.candleTimeframes) {
      for (const symbol of this.symbols) {
        if (this.candleIntervalMs > 0) await this.poll('candles', symbol, tf);
      }
    }

    for (const symbol of this.symbols) {
      if (this.tickerIntervalMs > 0) this.schedule('ticker', symbol, this.tickerIntervalMs);
      if (this.orderBookIntervalMs > 0) this.schedule('orderBook', symbol, this.orderBookIntervalMs);
      for (const tf of this.candleTimeframes) {
        if (this.candleIntervalMs > 0) this.schedule('candles', symbol, this.candleIntervalMs, tf);
      }
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.inFlight.clear();
  }

  /** Force an immediate fetch for one data kind / symbol. */
  async refresh(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): Promise<void> {
    await this.poll(kind, symbol, timeframe);
  }

  // ---- snapshot reads ----

  getTicker(symbol: string): Ticker | null {
    const st = this.state.get(this.key('ticker', symbol));
    return (st?.data as Ticker | null) ?? null;
  }

  getOrderBook(symbol: string): OrderBook | null {
    const st = this.state.get(this.key('orderBook', symbol));
    return (st?.data as OrderBook | null) ?? null;
  }

  getCandles(symbol: string, timeframe: Timeframe): Candle[] {
    const st = this.state.get(this.key('candles', symbol, timeframe));
    return st?.candles ?? [];
  }

  isStale(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): boolean {
    const st = this.state.get(this.key(kind, symbol, timeframe));
    // No snapshot at all is always stale, regardless of whether polling is on.
    if (!st || st.updatedMs === 0) return true;
    const interval = this.intervalFor(kind, timeframe);
    // With no explicit staleness window and no polling for this kind, there is
    // no freshness requirement.
    if (interval === 0 && !Number.isFinite(this.staleAfterMs)) return false;
    const tolerance = Number.isFinite(this.staleAfterMs)
      ? this.staleAfterMs
      : interval * DEFAULT_STALE_FACTOR;
    return Date.now() - st.updatedMs > tolerance;
  }

  lastError(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): Error | null {
    return this.state.get(this.key(kind, symbol, timeframe))?.error ?? null;
  }

  /** Most recent fetch time for a data kind, or null. */
  lastUpdatedMs(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): number | null {
    return this.state.get(this.key(kind, symbol, timeframe))?.updatedMs ?? null;
  }

  consecutiveFailures(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): number {
    return this.state.get(this.key(kind, symbol, timeframe))?.consecutiveFailures ?? 0;
  }

  // ---- internals ----

  private key(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): string {
    return timeframe ? `${kind}:${timeframe}:${symbol}` : `${kind}:${symbol}`;
  }

  private intervalFor(kind: MarketDataKind, _timeframe?: Timeframe): number {
    switch (kind) {
      case 'ticker':
        return this.tickerIntervalMs;
      case 'orderBook':
        return this.orderBookIntervalMs;
      case 'candles':
        return this.candleIntervalMs;
    }
  }

  private schedule(kind: MarketDataKind, symbol: string, intervalMs: number, timeframe?: Timeframe): void {
    const key = this.key(kind, symbol, timeframe);
    const timer = setInterval(() => void this.poll(kind, symbol, timeframe), intervalMs);
    this.timers.set(key, timer);
  }

  private async poll(kind: MarketDataKind, symbol: string, timeframe?: Timeframe): Promise<void> {
    const key = this.key(kind, symbol, timeframe);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      if (kind === 'ticker') {
        const ticker = await this.adapter.getTicker(symbol);
        // Stamp the local observation time on the stored snapshot so the risk
        // layer can measure TRANSPORT freshness (now - observedAtMs), distinct
        // from the exchange-reported quote time (ticker.timestampMs). We store
        // a copy so the provider never mutates the adapter's object.
        const stamped: Ticker = { ...ticker, observedAtMs: Date.now() };
        this.upsert(key, { data: stamped, candles: null, updatedMs: Date.now(), error: null, consecutiveFailures: 0 });
        this.events.emit('ticker', stamped);
      } else if (kind === 'orderBook') {
        const book = await this.adapter.getOrderBook(symbol);
        const stamped: OrderBook = { ...book, observedAtMs: Date.now() };
        this.upsert(key, { data: stamped, candles: null, updatedMs: Date.now(), error: null, consecutiveFailures: 0 });
        this.events.emit('orderBook', stamped);
      } else {
        const candles = await this.adapter.getCandles(symbol, timeframe!);
        this.upsert(key, { data: null, candles, updatedMs: Date.now(), error: null, consecutiveFailures: 0 });
        this.events.emit('candles', candles);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const prev = this.state.get(key);
      const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
      this.upsert(key, {
        data: prev?.data ?? null,
        candles: prev?.candles ?? null,
        updatedMs: prev?.updatedMs ?? 0,
        error,
        consecutiveFailures,
      });
      this.events.emit('failure', { kind, symbol, timeframe, error, consecutiveFailures });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private upsert(key: string, snap: Snapshot): void {
    this.state.set(key, snap);
  }
}