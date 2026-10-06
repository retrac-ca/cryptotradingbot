/**
 * Browser API client for the Stage 2 read-only monitoring API.
 *
 * SAFETY / ARCHITECTURE:
 *   - Always uses RELATIVE paths (`/api/...`). The origin/port is never
 *     hard-coded, so the UI works behind any reverse proxy or port mapping.
 *   - GET only. There is no method capable of a mutation.
 *   - Non-2xx responses are returned (not thrown) so callers can render the
 *     server's honest state (e.g. reconciliation 503 UNAVAILABLE) rather than
 *     inventing a clean success.
 *   - Transport/parse failures are normalized to a short, safe message; raw
 *     URLs/stack traces are never surfaced.
 *   - Monetary values remain exact decimal strings (the response is only
 *     parsed as JSON and never arithmetically coerced).
 */

import type {
  ApiErrorEnvelope,
  HealthSnapshot,
  MarketSnapshot,
  OrdersSnapshot,
  PortfolioSnapshot,
  ReconciliationResponse,
  SystemSnapshot,
} from './types.js';

export interface ApiResult<T> {
  /** True only for a 2xx response with a successfully parsed JSON body. */
  ok: boolean;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  data: T | null;
  /** Safe transport/parse error text, or null. */
  error: string | null;
}

export interface ApiClientOptions {
  /** Injectable fetch (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Per-request timeout. Defaults to 8000 ms. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8000;

export class ApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET a relative API path. Never throws for HTTP/transport failures; always
   * resolves with a structured {@link ApiResult}.
   */
  async get<T>(path: string): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        credentials: 'same-origin',
      });
      const text = await response.text();
      let data: T | null = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          return {
            ok: false,
            status: response.status,
            data: null,
            error: 'invalid response',
          };
        }
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          data,
          error: errorEnvelopeMessage(data) ?? `HTTP ${response.status}`,
        };
      }
      if (data === null) {
        return { ok: false, status: response.status, data: null, error: 'empty response' };
      }
      return { ok: true, status: response.status, data, error: null };
    } catch {
      return { ok: false, status: null, data: null, error: 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  getStatus(): Promise<ApiResult<SystemSnapshot>> {
    return this.get<SystemSnapshot>('/api/status');
  }

  getPortfolio(): Promise<ApiResult<PortfolioSnapshot>> {
    return this.get<PortfolioSnapshot>('/api/portfolio');
  }

  getOrders(): Promise<ApiResult<OrdersSnapshot>> {
    return this.get<OrdersSnapshot>('/api/orders');
  }

  getMarket(): Promise<ApiResult<MarketSnapshot>> {
    return this.get<MarketSnapshot>('/api/market');
  }

  getHealth(): Promise<ApiResult<HealthSnapshot>> {
    return this.get<HealthSnapshot>('/api/health');
  }

  getHealthz(): Promise<ApiResult<{ status: string }>> {
    return this.get<{ status: string }>('/api/healthz');
  }

  /**
   * Request the explicit, read-only reconciliation result. This is the ONLY
   * endpoint that triggers exchange reads + the shared mutation lock, and it is
   * NEVER polled automatically.
   */
  getReconciliation(): Promise<ApiResult<ReconciliationResponse>> {
    return this.get<ReconciliationResponse>('/api/reconciliation');
  }
}

function errorEnvelopeMessage(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const envelope = (data as ApiErrorEnvelope).error;
    if (envelope && typeof envelope.message === 'string' && envelope.message.length > 0) {
      return envelope.message;
    }
  }
  return null;
}
