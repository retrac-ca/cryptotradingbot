/**
 * Low-level NDAX REST client.
 *
 * Wire behavior follows the production-proven CCXT NDAX connector
 * (sign() and per-method request shapes), which was verified against ccxt's
 * ndax.ts during Phase 4 research:
 *
 *   - Base URL: `https://api.ndax.io:8443/AP` (production).
 *   - Reads (public AND private) use GET with x-www-form-urlencoded query
 *     params. Only mutations (e.g. SendOrder/CancelOrder) use POST with a JSON
 *     body.
 *   - Private auth (no session token): every request carries headers
 *     `Nonce`, `APIKey`, `Signature` (hex HMAC-SHA256 of `nonce+userId+apiKey`),
 *     `UserId`.
 *
 * Safety: the client NEVER reaches a real account unless an explicit
 * `fetchImpl` is provided and, for authenticated calls, the caller has enabled
 * them. Tests always inject a fake `fetchImpl`, so they can never touch live
 * NDAX.
 */

import {
  AuthenticationError,
  ExchangeError,
  InvalidCredentialsError,
  InvalidResponseError,
  OrderRejectedError,
  RateLimitError,
  ResourceNotFoundError,
  ServerError,
  TimeoutError,
  NetworkError,
} from '../errors.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface NdaxRestClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Minimum interval between requests. NDAX's FAQ suggests ~50 req/min; CCXT
   * assumes 1s. Default 1000ms. Set to 0 to disable (tests).
   */
  throttleMs?: number;
  /**
   * Supplies per-request auth headers (Nonce/APIKey/Signature/UserId) for
   * authenticated calls. Return null when auth is unavailable → an
   * AuthenticationError is thrown.
   */
  headersProvider?: () => Record<string, string> | null;
}

export class NdaxRestClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;
  private readonly headersProvider?: () => Record<string, string> | null;
  private lastRequestAtMs = 0;

  constructor(opts: NdaxRestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.throttleMs = opts.throttleMs ?? 1000;
    this.headersProvider = opts.headersProvider;
  }

  /** GET with x-www-form-urlencoded query params (NDAX reads). */
  async get(endpoint: string, params: Record<string, unknown> = {}, opts: { requiresAuth?: boolean } = {}): Promise<unknown> {
    return this.request('GET', endpoint, params, opts);
  }

  /** POST with a JSON body (NDAX mutations like SendOrder/CancelOrder). */
  async post(endpoint: string, body: Record<string, unknown>, opts: { requiresAuth?: boolean } = {}): Promise<unknown> {
    return this.request('POST', endpoint, body, opts);
  }

  private async request(
    method: 'GET' | 'POST',
    endpoint: string,
    payload: Record<string, unknown>,
    opts: { requiresAuth?: boolean },
  ): Promise<unknown> {
    await this.throttle();

    const headers: Record<string, string> = {};
    if (method === 'POST') headers['Content-Type'] = 'application/json';    if (opts.requiresAuth) {
      const authHeaders = this.headersProvider?.() ?? null;
      if (!authHeaders) {
        throw new AuthenticationError(
          `NDAX ${endpoint}: authenticated call attempted without auth headers. ` +
            'Authenticated NDAX calls need Nonce/APIKey/Signature/UserId headers, ' +
            'which are only provided when authenticated reads are enabled.',
        );
      }
      Object.assign(headers, authHeaders);
    }

    let url = `${this.baseUrl}/${endpoint}`;
    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      init.body = JSON.stringify(payload);
    } else {
      const query = urlencode(payload);
      if (query.length > 0) url += `?${query}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError(`NDAX ${endpoint}: request timed out after ${this.timeoutMs}ms`);
      }
      throw new NetworkError(`NDAX ${endpoint}: network failure - ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    let data: unknown;
    let raw = '';
    try {
      raw = await res.text();
    } catch (err) {
      throw new NetworkError(`NDAX ${endpoint}: failed to read response body - ${(err as Error).message}`);
    }
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    } else {
      data = '';
    }

    this.throwForResponse(endpoint, res.status, data, opts.requiresAuth ?? false);
    return data;
  }

  /** Enforce a minimum fixed delay between requests (rate limiting). */
  private async throttle(): Promise<void> {
    if (this.throttleMs <= 0) return;
    const elapsed = Date.now() - this.lastRequestAtMs;
    if (this.lastRequestAtMs !== 0 && elapsed < this.throttleMs) {
      await delay(this.throttleMs - elapsed);
    }
    this.lastRequestAtMs = Date.now();
  }

  private throwForResponse(endpoint: string, status: number, data: unknown, requiresAuth: boolean): void {
    if (status === 429 || (isRecord(data) && Number(data.errorcode) === 105)) {
      throw new RateLimitError(`NDAX ${endpoint}: rate limited (status ${status})`);
    }
    if (status === 401) {
      throw new InvalidCredentialsError(`NDAX ${endpoint}: unauthorized (401)`);
    }
    if (status === 403) {
      throw new AuthenticationError(`NDAX ${endpoint}: forbidden (403) — IP restriction?`);
    }
    if (status >= 500) {
      throw new ServerError(`NDAX ${endpoint}: server error (${status})`);
    }

    // NDAX may return an error array like [errCode, errMsg] for some calls.
    if (Array.isArray(data) && typeof data[0] === 'number' && data[0] !== 0 && data.length >= 2) {
      throw this.mapError(endpoint, data[0], String(data[1]), '');
    }

    if (isRecord(data)) {
      const errorcode = Number(data.errorcode ?? 0);
      const errormsg = typeof data.errormsg === 'string' ? data.errormsg : '';
      const isError = errorcode !== 0 || (data.result === false && errormsg.length > 0) || status >= 400;
      if (isError) {
        throw this.mapError(endpoint, errorcode, errormsg || `HTTP ${status}`, errormsg);
      }
    }

    if (status >= 400) {
      throw requiresAuth
        ? new AuthenticationError(`NDAX ${endpoint}: HTTP ${status} on an authenticated call`)
        : new ResourceNotFoundError(`NDAX ${endpoint}: HTTP ${status}`);
    }
  }

  private mapError(endpoint: string, code: number, msg: string, errormsg: string): ExchangeError {
    // CCXT maps these errormsg texts to specific error types; added for parity.
    const broad = errormsg || msg;
    if (broad.includes('2FACode') || /not authorized|not_been_authenticated/i.test(broad)) {
      return new AuthenticationError(`NDAX ${endpoint}: not authorized - ${broad}`.trim());
    }
    if (broad.includes('Not_Enough_Funds') || /insufficient/i.test(broad)) {
      return new OrderRejectedError(`NDAX ${endpoint}: insufficient funds - ${broad}`.trim(), 101);
    }
    if (/server error/i.test(broad)) {
      return new ServerError(`NDAX ${endpoint}: server error - ${broad}`.trim());
    }
    if (broad.includes('Invalid InstrumentId') || /resource not found/i.test(broad)) {
      return new ResourceNotFoundError(`NDAX ${endpoint}: resource not found - ${broad}`.trim());
    }

    switch (code) {
      case 20: return new AuthenticationError(`NDAX ${endpoint}: not authorized (20) ${msg}`.trim());
      case 100: return new InvalidResponseError(`NDAX ${endpoint}: invalid response (100) ${msg}`.trim());
      case 101: return new OrderRejectedError(`NDAX ${endpoint}: operation failed (101) ${msg}`.trim(), 101);
      case 102: return new ServerError(`NDAX ${endpoint}: server error (102) ${msg}`.trim());
      case 104: return new ResourceNotFoundError(`NDAX ${endpoint}: resource not found (104) ${msg}`.trim());
      case 106: return new ExchangeError(`NDAX ${endpoint}: operation not supported (106) ${msg}`.trim());
      default: return new ExchangeError(`NDAX ${endpoint}: error ${code} ${msg}`.trim(), code);
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize params as x-www-form-urlencoded (same semantics as CCXT urlencode). */
function urlencode(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}