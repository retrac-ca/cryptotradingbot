/**
 * `bot dashboard` — run the READ-ONLY monitoring HTTP API.
 *
 * This command starts a deliberately narrow, GET-only HTTP server that exposes
 * the Stage 1 monitoring read model. It is OBSERVATIONAL ONLY:
 *   - it never places, cancels, resolves, or accounts for an order,
 *   - it never imports the live execution / controlled-authorization /
 *     reconciliation-mutation paths,
 *   - it never modifies any state store,
 *   - it does not start automatically with (and does not alter) `bot start`,
 *   - it binds to loopback by default.
 *
 * The exchange adapter it constructs is used solely for read-only health and
 * reconciliation reads; `MonitoringService` wraps it in a read-only facade that
 * throws on `placeOrder`/`cancelOrder`.
 *
 * This command is the composition root: it owns config loading and state-store
 * construction. The HTTP layer (`src/api`) depends only on the monitoring read
 * model and never sees these details.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { createShutdown } from '../shutdown.js';
import {
  ManagedStateStore,
  OrderStore,
  PaperStateStore,
  StateInitMarker,
} from '../persistence/index.js';
import { ManualIntentStore } from '../manual/ManualIntentStore.js';
import { MonitoringService } from '../monitoring/index.js';
import { createMonitoringServer, isLoopbackHost, StaticAssets } from '../api/index.js';
import { VERSION, type CommandHandler } from './context.js';

interface DashboardArgs {
  host: string;
  port: number;
}

const USAGE = `bot dashboard — READ-ONLY monitoring HTTP API (observational only)

Usage: bot dashboard [--host <addr>] [--port <n>]

Serves GET-only JSON endpoints (no order placement/cancellation, no auth):
  GET /api/healthz        process liveness (does not contact NDAX)
  GET /api/status         system/status read model
  GET /api/portfolio      PAPER and LIVE managed portfolios (never combined)
  GET /api/orders         durable order-ledger monitoring view
  GET /api/market         in-process market-data view (UNAVAILABLE if none)
  GET /api/health         explicit read-only exchange health check
  GET /api/reconciliation explicit read-only reconciliation result

When built dashboard assets are present (npm run build), GET / serves the
read-only browser dashboard UI. Binds to 127.0.0.1 by default and REFUSES a
non-loopback host unless DASHBOARD_ALLOW_REMOTE=true. Requests are rejected
unless the Host header exactly matches DASHBOARD_ALLOWED_HOSTS (default:
127.0.0.1,localhost,::1). Do NOT expose this API publicly: it has no
authentication. For private remote access, keep this on loopback and front it
with a private access layer (see docs/DASHBOARD_DEPLOYMENT.md). Press Ctrl-C
to stop.
`;

/**
 * Resolve the dashboard static-asset directory. Uses an explicit configured
 * directory when set, otherwise the default built output (`dist/dashboard`).
 * Resolved relative to this module so it works in both `src` (tsx) and `dist`.
 */
function resolveStaticDir(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed !== '') return resolve(trimmed);
  return fileURLToPath(new URL('../../dist/dashboard/', import.meta.url));
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Parse `--host`/`--port` overrides (defaults come from config). */
function parseArgs(
  args: string[],
  defaultHost: string,
  defaultPort: number,
): DashboardArgs | { error: string } {
  let host = defaultHost;
  let port = defaultPort;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--host') {
      const value = args[++i];
      if (!value) return { error: 'missing value for --host' };
      host = value;
    } else if (arg === '--port') {
      const value = args[++i];
      if (value === undefined) return { error: 'missing value for --port' };
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { error: `--port must be an integer in 1..65535 (got "${value}")` };
      }
      port = n;
    } else {
      return { error: `unknown flag "${arg}"` };
    }
  }
  return { host, port };
}

export const dashboardCommand: CommandHandler = async (args, { logger }): Promise<number> => {
  if (args.includes('--help') || args.includes('-h')) {
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 0;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  const parsed = parseArgs(args, cfg.dashboardHost, cfg.dashboardPort);
  if ('error' in parsed) {
    // eslint-disable-next-line no-console
    console.error('Argument error: ' + parsed.error + '\n');
    // eslint-disable-next-line no-console
    console.log(USAGE);
    return 1;
  }

  // Fail closed BEFORE constructing any adapter: the dashboard is an
  // unauthenticated read-only API, so it must stay on loopback unless the
  // operator has explicitly acknowledged the exposure. The preferred remote
  // path is a private access layer (e.g. Tailscale) in front of loopback.
  if (!isLoopbackHost(parsed.host) && !cfg.dashboardAllowRemote) {
    // eslint-disable-next-line no-console
    console.error(
      `Refusing to bind the dashboard to non-loopback host "${parsed.host}".\n` +
        'The monitoring API has no authentication. Keep it on 127.0.0.1 and reach it\n' +
        'through a private, authenticated access layer (see docs/DASHBOARD_DEPLOYMENT.md).\n' +
        'To override intentionally, set DASHBOARD_ALLOW_REMOTE=true.',
    );
    return 1;
  }

  // Read-only credentials context. The adapter is handed to MonitoringService,
  // which wraps it in a read-only facade; this command never calls a write
  // method on it.
  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  const adapter = createExchange(cfg.exchange, {
    credentials,
    config: {
      enableAuthenticatedReads: cfg.enableAuthenticatedReads,
      baseUrl: cfg.ndaxRestBaseUrl,
    },
  });

  const monitoring = new MonitoringService({
    config: cfg,
    version: VERSION,
    orders: new OrderStore(cfg.orderLedgerFile),
    paper: new PaperStateStore(cfg.paperStateFile),
    live: new ManagedStateStore(cfg.liveManagedStateFile),
    manualIntents: new ManualIntentStore(cfg.manualIntentFile),
    initMarker: new StateInitMarker(join(cfg.stateDir, '.init.json')),
    stateDir: cfg.stateDir,
    // No in-process market data provider in a standalone dashboard process:
    // /api/market reports UNAVAILABLE rather than inventing values.
    adapter,
    nowMs: () => Date.now(),
    logger,
  });

  // Serve the built dashboard UI when available. The static root is confined
  // to this directory; /api/* is always handled as API and never served as a
  // file. If assets are absent, the API still runs and this logs a hint.
  const staticDir = resolveStaticDir(cfg.dashboardStaticDir);
  const staticAssets = isDirectory(staticDir) ? new StaticAssets(staticDir) : undefined;
  if (!staticAssets) {
    logger.warn(
      { staticDir },
      'dashboard UI assets not found; serving API only (run `npm run build` to build the UI)',
    );
  }

  const server = createMonitoringServer({
    monitoring,
    host: parsed.host,
    port: parsed.port,
    logger,
    // Defense-in-depth: scrub known local state paths from responses.
    redactPaths: [cfg.stateDir, resolve(cfg.stateDir)],
    ...(staticAssets ? { staticAssets } : {}),
    // The server also enforces this; passing it here keeps the two layers in
    // agreement. Defaults to false (loopback-only).
    allowNonLoopback: cfg.dashboardAllowRemote,
    // Exact request-Host allowlist (DNS-rebinding / cross-site boundary).
    allowedHosts: cfg.dashboardAllowedHosts,
  });

  let address: { host: string; port: number };
  try {
    address = await server.listen();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'failed to start monitoring dashboard');
    // eslint-disable-next-line no-console
    console.error('Failed to start monitoring dashboard: ' + message);
    return 1;
  }

  logger.info(
    { host: address.host, port: address.port, mode: 'READ-ONLY' },
    'monitoring dashboard listening (no trading controls)',
  );
  // eslint-disable-next-line no-console
  console.log(`Read-only monitoring dashboard listening on http://${address.host}:${address.port}`);
  if (staticAssets) {
    // eslint-disable-next-line no-console
    console.log(`  UI:  http://${address.host}:${address.port}/`);
  } else {
    // eslint-disable-next-line no-console
    console.log('  UI:  not built (run `npm run build` to build and serve the dashboard UI)');
  }
  // eslint-disable-next-line no-console
  console.log('  GET /api/healthz /api/status /api/portfolio /api/orders /api/market /api/health /api/reconciliation');
  // eslint-disable-next-line no-console
  console.log('  Observational only. No order placement/cancellation. Press Ctrl-C to stop.');

  const shutdown = createShutdown();
  await shutdown.waitAndFinalize(() => {
    void server.close();
  });

  logger.info('monitoring dashboard stopped');
  return 0;
};
