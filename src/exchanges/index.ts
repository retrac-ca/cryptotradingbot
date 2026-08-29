/**
 * Exchanges barrel. Importing this module registers all concrete adapters with
 * the registry, so `createExchange('ndax', ...)` works after a single import.
 * The trading engine depends only on the types and registry exported here; it
 * never imports exchange-specific classes directly.
 */

import './ndax/index.js';

export { ExchangeAdapter, type ExchangeHealth, type PlaceOrderResult, type CancelResult, type OrderPlacementSafety } from './ExchangeAdapter.js';
export type { ExchangeCapabilities } from './types.js';
export {
  ExchangeError,
  NetworkError,
  TimeoutError,
  RateLimitError,
  AuthenticationError,
  InvalidCredentialsError,
  ResourceNotFoundError,
  InvalidResponseError,
  OrderRejectedError,
  UnknownOrderOutcomeError,
  ServerError,
} from './errors.js';
export {
  registerExchange,
  createExchange,
  getSupportedExchanges,
  isExchangeSupported,
  resetExchangeRegistry,
} from './registry.js';
