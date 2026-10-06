/**
 * MonitoringHttpServer — a minimal, strictly READ-ONLY HTTP API over the
 * Stage 1 monitoring read model.
 *
 * DEPENDENCY DIRECTION
 *   HTTP → MonitoringService (read model) → existing authoritative readers.
 *   This module knows NOTHING about state stores, NDAX internals, Portfolio
 *   accounting, reconciliation internals, or execution. It never imports them.
 *
 * SECURITY / SAFETY
 *   - GET-only routes. There are no POST/PUT/PATCH/DELETE handlers (405).
 *   - No request bodies are accepted (400), no filesystem access, no shell,
 *     no query-based commands, no generic exchange proxy.
 *   - No CORS headers (same-origin future UI only; no `Access-Control-Allow-*`).
 *   - Defaults to loopback (127.0.0.1); never 0.0.0.0.
 *   - Error envelopes never include stack traces or raw exception objects.
 *   - Response bodies are serialized with plain `JSON.stringify`, which uses the
 *     project's existing value conventions (`Money.toJSON()` → exact decimal
 *     string). Monetary values are never converted to floating point.
 *   - Optional `redactPaths` scrubs known local state paths from serialized
 *     responses (defense-in-depth against leaking filesystem paths).
 *
 * It uses only Node's built-in `node:http` (no framework dependency).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../logging/logger.js';
import type {
  HealthSnapshot,
  MonitoringSnapshot,
  ReconciliationSnapshot,
} from '../monitoring/index.js';
import type { StaticAsset, StaticAssets } from './staticFiles.js';

/**
 * The narrow read-model interface the HTTP layer depends on. `MonitoringService`
 * structurally satisfies it. Injecting this abstraction keeps routes unit-
 * testable without NDAX or filesystem access.
 */
export interface MonitoringReadModel {
  getSnapshot(): Promise<MonitoringSnapshot>;
  getHealth(): Promise<HealthSnapshot>;
  getReconciliation(): Promise<ReconciliationSnapshot>;
}

export interface MonitoringServerDeps {
  monitoring: MonitoringReadModel;
  /** Bind host. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** Bind port. Defaults to `8787`. */
  port?: number;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /**
   * Known local paths to redact from serialized responses (defense-in-depth).
   * Configured by the composition root; contains no secrets.
   */
  redactPaths?: string[];
  /**
   * Optional, explicitly confined static asset reader. When present, non-API
   * GET/HEAD requests are served from this reader (the dashboard UI). `/api/*`
   * routes are ALWAYS handled as API and never fall through to static files.
   */
  staticAssets?: StaticAssets;
  /**
   * Explicit opt-in required to bind to a NON-loopback address. Defaults to
   * `false`, so a misconfigured host cannot silently turn this
   * unauthenticated read-only API into a network-wide listener. Remote access
   * should be provided by a private, authenticated access layer (e.g. a
   * Tailscale tailnet) while the server keeps listening on loopback.
   */
  allowNonLoopback?: boolean;
  /**
   * Explicit allowlist of request `Host` hostnames. A request whose `Host`
   * hostname is not in this list is rejected (421) before ANY endpoint work,
   * which prevents DNS-rebinding from directing an attacker-controlled
   * hostname at the loopback API. Hostnames are compared exactly (no wildcards
   * or suffix matching). The port portion is parsed and validated but is not
   * part of the match, so a future reverse proxy (e.g. Tailscale Serve) that
   * presents the tailnet hostname without a port keeps working once the
   * operator adds that hostname here. Defaults to loopback-only hostnames.
   */
  allowedHosts?: readonly string[];
}

export interface MonitoringServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  /** Start listening. Resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }>;
  /** Stop accepting connections and release sockets. */
  close(): Promise<void>;
}

export const DEFAULT_MONITORING_HOST = '127.0.0.1';
export const DEFAULT_MONITORING_PORT = 8787;

/**
 * True only for loopback/link-local-host bind addresses (`localhost`, `::1`,
 * `127.0.0.0/8`). `0.0.0.0`, `::`, and any LAN/public address are NOT loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '') return false;
  if (h === 'localhost' || h === '::1') return true;
  if (h === '::ffff:127.0.0.1') return true;
  if (h.startsWith('127.')) {
    const parts = h.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }
  return false;
}

/** Default request-host allowlist: loopback hostnames only (no wildcards). */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/**
 * Parse a `Host` header (or allowlist entry) into its hostname. Bracketed IPv6
 * is supported. The optional port is validated but intentionally NOT returned
 * for matching (see `allowedHosts` docs). Returns `null` when malformed.
 */
function parseHostValue(value: string): { hostname: string; port: number | null } | null {
  const raw = value.trim();
  if (raw.length === 0) return null;

  let hostname: string;
  let portRaw: string | null = null;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end <= 1) return null;
    hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(':')) return null;
      portRaw = rest.slice(1);
    }
  } else {
    const colon = raw.indexOf(':');
    if (colon === -1) {
      hostname = raw;
    } else if (raw.indexOf(':', colon + 1) === -1) {
      hostname = raw.slice(0, colon);
      portRaw = raw.slice(colon + 1);
    } else {
      // Multiple colons with no brackets: treat as a bare IPv6 literal (used
      // for allowlist entries such as `::1`); anything else is malformed.
      if (!/^[0-9A-Fa-f:]+$/.test(raw)) return null;
      hostname = raw;
    }
  }

  hostname = hostname.trim().toLowerCase();
  if (hostname.length === 0) return null;

  let port: number | null = null;
  if (portRaw !== null) {
    if (!/^\d{1,5}$/.test(portRaw)) return null;
    port = Number(portRaw);
    if (port < 1 || port > 65535) return null;
  }
  return { hostname, port };
}

/** Normalize a `Host` header or allowlist entry to a comparable hostname. */
function normalizeHostname(value: string): string | null {
  const parsed = parseHostValue(value);
  return parsed ? parsed.hostname : null;
}

function normalizeAllowedHosts(allowedHosts: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const entry of allowedHosts) {
    const hostname = normalizeHostname(entry);
    if (hostname) set.add(hostname);
  }
  return set;
}

/**
 * True only if the request `Host` hostname is explicitly allowlisted. Missing,
 * malformed, or non-allowlisted hosts all return false (fail closed). Exact
 * hostname comparison — never substring/suffix/wildcard matching.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): boolean {
  if (!hostHeader) return false;
  const hostname = normalizeHostname(hostHeader);
  if (!hostname) return false;
  return normalizeAllowedHosts(allowedHosts).has(hostname);
}

/** Outcome of the request-origin (Host + cross-site) boundary check. */
export interface OriginDecision {
  allowed: boolean;
  status: number;
  code: string;
}

function stripIpv6Brackets(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function hostnameFromOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return stripIpv6Brackets(url.hostname);
  } catch {
    return null;
  }
}

export interface RequestOriginHeaders {
  host?: string;
  secFetchSite?: string;
  origin?: string;
}

/**
 * The request-origin boundary, applied BEFORE any endpoint work.
 *
 *  1. `Host` must be present, well-formed, and exactly allowlisted (primary
 *     defense against DNS rebinding).
 *  2. A `Sec-Fetch-Site: cross-site` request is rejected.
 *  3. A present, non-`null` `Origin` must resolve to an allowlisted hostname.
 *
 * Absent `Sec-Fetch-Site`/`Origin` (e.g. curl, direct navigation) are allowed
 * once the Host passes, so non-browser clients and normal dashboard use keep
 * working.
 */
export function evaluateRequestOrigin(
  headers: RequestOriginHeaders,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_HOSTS,
): OriginDecision {
  const allow = normalizeAllowedHosts(allowedHosts);

  if (!headers.host) return { allowed: false, status: 400, code: 'BAD_REQUEST' };
  const hostname = normalizeHostname(headers.host);
  if (!hostname) return { allowed: false, status: 400, code: 'BAD_REQUEST' };
  if (!allow.has(hostname)) return { allowed: false, status: 421, code: 'MISDIRECTED_REQUEST' };

  if (headers.secFetchSite !== undefined) {
    const site = headers.secFetchSite.trim().toLowerCase();
    if (site === 'cross-site') return { allowed: false, status: 403, code: 'FORBIDDEN' };
  }

  if (headers.origin !== undefined && headers.origin.length > 0) {
    if (headers.origin.trim().toLowerCase() === 'null') {
      return { allowed: false, status: 403, code: 'FORBIDDEN' };
    }
    const originHost = hostnameFromOrigin(headers.origin);
    if (!originHost || !allow.has(originHost)) {
      return { allowed: false, status: 403, code: 'FORBIDDEN' };
    }
  }

  return { allowed: true, status: 200, code: 'OK' };
}

const REDACTED_PATH = '[redacted-path]';

/** The only accepted route paths. Everything else is 404. */
const KNOWN_PATHS: ReadonlySet<string> = new Set([
  '/api/healthz',
  '/api/status',
  '/api/portfolio',
  '/api/orders',
  '/api/market',
  '/api/health',
  '/api/reconciliation',
]);

interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Coerce a single-valued request header to a string (or undefined). */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** True if the request declares a body (all valid routes are bodyless GETs). */
function declaresBody(req: IncomingMessage): boolean {
  const transferEncoding = req.headers['transfer-encoding'];
  if (typeof transferEncoding === 'string' && transferEncoding.length > 0) return true;
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const n = Number(contentLength);
    return Number.isFinite(n) && n > 0;
  }
  return false;
}

function redact(text: string, paths: readonly string[]): string {
  let out = text;
  for (const path of paths) {
    if (!path) continue;
    out = out.split(path).join(REDACTED_PATH);
  }
  return out;
}

/**
 * Route a request to the monitoring read model.
 *
 * Snapshot-backed routes (`status`/`portfolio`/`orders`/`market`) call
 * `getSnapshot()` — which performs NO exchange requests and NO reconciliation.
 * Only `/api/reconciliation` calls `getReconciliation()`; only `/api/health`
 * calls `getHealth()`.
 */
async function dispatch(model: MonitoringReadModel, pathname: string): Promise<JsonResponse> {
  switch (pathname) {
    // Cheap liveness: never touches the monitoring service or NDAX.
    case '/api/healthz':
      return { status: 200, body: { status: 'ok' } };

    case '/api/status':
      return { status: 200, body: (await model.getSnapshot()).system };

    case '/api/portfolio':
      return { status: 200, body: (await model.getSnapshot()).portfolios };

    case '/api/orders':
      return { status: 200, body: (await model.getSnapshot()).orders };

    case '/api/market':
      return { status: 200, body: (await model.getSnapshot()).market };

    case '/api/health': {
      const health = await model.getHealth();
      return { status: health.status === 'OK' ? 200 : 503, body: health };
    }

    case '/api/reconciliation': {
      const reconciliation = await model.getReconciliation();
      if (reconciliation.status === 'UNAVAILABLE') {
        return { status: 503, body: reconciliation };
      }
      if (reconciliation.status === 'ERROR') {
        // Preserve no raw exception detail over the wire; logged server-side.
        return {
          status: 500,
          body: errorBody('RECONCILIATION_READ_FAILED', 'reconciliation read failed'),
        };
      }
      // READY / RECONCILIATION_REQUIRED / HALTED are valid domain results.
      // HALTED (e.g. mutation-lock contention) is preserved, never converted
      // into a clean success.
      return { status: 200, body: reconciliation };
    }

    default:
      return { status: 404, body: errorBody('NOT_FOUND', 'not found') };
  }
}

/** True when a pathname belongs to the API namespace (`/api` or `/api/...`). */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Restrictive CSP for the dashboard HTML. The UI uses only external,
 * same-origin assets (no inline scripts/styles), so no `unsafe-inline` or
 * `unsafe-eval` is required.
 */
const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function sendAsset(res: ServerResponse, asset: StaticAsset, headOnly: boolean): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const headers: Record<string, string | number> = {
    'Content-Type': asset.contentType,
    'Content-Length': asset.body.byteLength,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  // Browser-document hardening applies ONLY to HTML; API JSON responses must
  // not receive document-only headers.
  if (asset.contentType.toLowerCase().includes('text/html')) {
    headers['Content-Security-Policy'] = HTML_CSP;
    headers['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, headers);
  res.end(headOnly ? undefined : asset.body);
}

function sendJson(res: ServerResponse, response: JsonResponse, redactPaths: readonly string[]): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  let status = response.status;
  let payload: string;
  try {
    payload = JSON.stringify(response.body ?? null);
  } catch {
    // Should never happen for the monitoring read model; fail closed safely.
    status = 500;
    payload = JSON.stringify(errorBody('INTERNAL_ERROR', 'internal error'));
  }
  payload = redact(payload, redactPaths);

  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(response.headers ?? {}),
  };
  res.writeHead(status, headers);
  res.end(payload);
}

async function handleRequest(
  deps: MonitoringServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const redactPaths = deps.redactPaths ?? [];
  const allowedHosts = deps.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  try {
    // Request-origin boundary FIRST, before any body handling, routing, state
    // read, exchange call, or reconciliation/lock work. This is the primary
    // defense against DNS rebinding and cross-site triggering of sensitive
    // endpoints; a rejected request can never reach MonitoringService.
    const decision = evaluateRequestOrigin(
      {
        host: headerValue(req.headers.host),
        secFetchSite: headerValue(req.headers['sec-fetch-site']),
        origin: headerValue(req.headers.origin),
      },
      allowedHosts,
    );
    if (!decision.allowed) {
      req.resume();
      sendJson(res, { status: decision.status, body: errorBody(decision.code, 'request origin rejected') }, redactPaths);
      return;
    }

    // Reject any request that declares a body (no body-accepting routes exist).
    if (declaresBody(req)) {
      req.resume();
      sendJson(res, { status: 400, body: errorBody('BAD_REQUEST', 'request body is not accepted') }, redactPaths);
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, { status: 400, body: errorBody('BAD_REQUEST', 'malformed request target') }, redactPaths);
      return;
    }

    // The API namespace is handled exclusively as API: known paths only,
    // GET only. It NEVER falls through to static assets, so a file under a
    // static root can never shadow or alter an API route.
    if (isApiPath(pathname)) {
      if (!KNOWN_PATHS.has(pathname)) {
        sendJson(res, { status: 404, body: errorBody('NOT_FOUND', 'not found') }, redactPaths);
        return;
      }
      if (req.method !== 'GET') {
        sendJson(
          res,
          {
            status: 405,
            body: errorBody('METHOD_NOT_ALLOWED', 'method not allowed'),
            headers: { Allow: 'GET' },
          },
          redactPaths,
        );
        return;
      }
      const response = await dispatch(deps.monitoring, pathname);
      sendJson(res, response, redactPaths);
      return;
    }

    // Non-API paths: optionally serve the confined dashboard static assets.
    if (!deps.staticAssets) {
      sendJson(res, { status: 404, body: errorBody('NOT_FOUND', 'not found') }, redactPaths);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(
        res,
        {
          status: 405,
          body: errorBody('METHOD_NOT_ALLOWED', 'method not allowed'),
          headers: { Allow: 'GET, HEAD' },
        },
        redactPaths,
      );
      return;
    }
    const asset = await deps.staticAssets.read(pathname);
    if (!asset) {
      sendJson(res, { status: 404, body: errorBody('NOT_FOUND', 'not found') }, redactPaths);
      return;
    }
    sendAsset(res, asset, req.method === 'HEAD');
  } catch (err) {
    // Log server-side only; never echo the raw exception to the client.
    deps.logger?.error({ err }, 'monitoring API request failed');
    sendJson(res, { status: 500, body: errorBody('INTERNAL_ERROR', 'internal error') }, redactPaths);
  }
}

/**
 * Create the read-only monitoring HTTP server. The returned server is NOT
 * listening until `listen()` is called.
 */
export function createMonitoringServer(deps: MonitoringServerDeps): MonitoringServer {
  const host = deps.host ?? DEFAULT_MONITORING_HOST;
  const port = deps.port ?? DEFAULT_MONITORING_PORT;

  // Fail closed: this API is unauthenticated, so a non-loopback bind must be an
  // explicit, deliberate opt-in. This prevents an accidental `0.0.0.0`/LAN bind
  // (e.g. from a stray env var) from silently exposing it on the network.
  if (!deps.allowNonLoopback && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind the read-only monitoring API to non-loopback host "${host}". ` +
        'Keep the dashboard on 127.0.0.1 and expose it via a private, authenticated ' +
        'access layer (e.g. Tailscale). To override intentionally, pass allowNonLoopback.',
    );
  }

  const server = createServer((req, res) => {
    void handleRequest(deps, req, res);
  });

  // Malformed HTTP (e.g. bad request line) must not produce detailed output.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  return {
    host,
    port,
    server,
    listen: () =>
      new Promise<{ host: string; port: number }>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          const address = server.address();
          if (address && typeof address === 'object') {
            resolve({ host: address.address, port: address.port });
          } else {
            resolve({ host, port });
          }
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Release keep-alive/idle sockets so shutdown is prompt and deterministic.
        server.closeAllConnections();
      }),
  };
}
