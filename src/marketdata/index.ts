/**
 * Market data layer.
 *
 * Exposes `LiveMarketData` (a polling snapshot provider over an ExchangeAdapter)
 * and the `MarketDataProvider` interface that strategies consume. Historical /
 * simulated providers (backtesting) implement the same `MarketDataProvider`
 * interface later.
 */

export { LiveMarketData } from './LiveMarketData.js';
export type {
  MarketDataConfig,
  MarketDataKind,
  MarketDataProvider,
  MarketDataErrorEvent,
} from './types.js';
