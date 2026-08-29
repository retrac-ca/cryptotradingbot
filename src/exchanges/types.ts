/**
 * Exchange capabilities.
 *
 * Not every exchange supports every feature. Rather than throwing "not
 * implemented" errors, an adapter declares which features it supports via these
 * flags, and the trading engine checks them to decide how to behave gracefully.
 */

export interface ExchangeCapabilities {
  /** Can retrieve live/historical OHLCV candles. */
  supportsCandles: boolean;
  /** Has a real-time WebSocket market-data feed. */
  supportsWebSocket: boolean;
  /** Can place market orders. */
  supportsMarketOrders: boolean;
  /** Can place limit orders. */
  supportsLimitOrders: boolean;
  /** Provides order-book snapshots. */
  supportsOrderBook: boolean;
  /** Provides fee information. */
  supportsFees: boolean;
  /** Provides per-market precision/metadata (tick sizes). */
  supportsMarketInfo: boolean;
  /**
   * Order placement is implemented by this adapter. For safety, adapters must
   * NOT allow ordering to reach a real account until explicitly enabled.
   */
  supportsOrderPlacement: boolean;
  /**
   * Public market data can be retrieved WITHOUT API credentials. This matters
   * for paper/simulated trading that should not require trading permissions.
   */
  publicDataRequiresAuth: boolean;
}

export const NO_CAPABILITIES: ExchangeCapabilities = {
  supportsCandles: false,
  supportsWebSocket: false,
  supportsMarketOrders: false,
  supportsLimitOrders: false,
  supportsOrderBook: false,
  supportsFees: false,
  supportsMarketInfo: false,
  supportsOrderPlacement: false,
  publicDataRequiresAuth: true,
};
