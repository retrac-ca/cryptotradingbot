/**
 * Exchange error hierarchy.
 *
 * Categorizing failures is essential for financial safety. In particular the
 * distinction between a DEFINITE and AMBIGUOUS failure determines whether an
 * order may be retried:
 *
 * - AMBIGUOUS (e.g. network timeout after submitting an order): the exchange
 *   MAY have accepted the order. The caller MUST reconcile with the exchange
 *   (GetOrderStatus / GetOpenOrders) before possibly re-submitting, to avoid
 *   duplicate orders.
 * - DEFINITE (e.g. explicit rejection, invalid symbol): the exchange did not
 *   accept the order, so a retry is safe.
 *
 * All errors from adapters should be one of these types so the execution engine
 * can reason about them.
 */

/** Base class for all exchange-related errors. */
export class ExchangeError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The network/transport failed before we know the outcome. Timeout/connection. */
export class NetworkError extends ExchangeError {}

/** A request timed out. AMBIGUOUS if it may have reached the exchange. */
export class TimeoutError extends NetworkError {
  constructor(message: string) {
    super(message);
  }
}

/** The exchange is rejecting our traffic due to rate limiting. */
export class RateLimitError extends ExchangeError {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Authentication or authorization failure (bad/invalid/insufficient). */
export class AuthenticationError extends ExchangeError {}

/** Credentials were provided but the exchange rejected them as invalid. */
export class InvalidCredentialsError extends AuthenticationError {}

/** The requested resource (symbol/order/instrument) does not exist. */
export class ResourceNotFoundError extends ExchangeError {}

/** The exchange returned an unexpected/malformed/unknown response. AMBIGUOUS. */
export class InvalidResponseError extends ExchangeError {
  constructor(message: string) {
    super(message);
  }
}

/** The exchange explicitly rejected the request/order (DEFINITE). */
export class OrderRejectedError extends ExchangeError {
  constructor(message: string, code: number | null = null) {
    super(message, code);
  }
}

/**
 * Order submission outcome is UNKNOWN (rare). Always reconcile before
 * considering the order placed, and never auto-retry without reconciliation.
 */
export class UnknownOrderOutcomeError extends ExchangeError {
  constructor(message: string) {
    super(message);
  }
}

/** Server-side exchange error (5xx or "Server Error"). Retryable but unknown. */
export class ServerError extends ExchangeError {}
