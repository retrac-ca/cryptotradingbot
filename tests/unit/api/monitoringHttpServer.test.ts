import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMonitoringServer,
  DEFAULT_MONITORING_HOST,
  DEFAULT_MONITORING_PORT,
} from '../../../src/api/index.js';
import type { MonitoringReadModel, MonitoringServer } from '../../../src/api/index.js';
import { MonitoringService } from '../../../src/monitoring/index.js';
import type {
  HealthSnapshot,
  MonitoringSnapshot,
  OrderSnapshot,
  PortfolioRealmSnapshot,
  PositionSnapshot,
  ReconciliationSnapshot,
} from '../../../src/monitoring/index.js';
import {
  ManagedStateStore,
  OrderStore,
  PaperStateStore,
  StateInitMarker,
} from '../../../src/persistence/index.js';
import { ManualIntentStore } from '../../../src/manual/ManualIntentStore.js';
import type { BotConfig } from '../../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const servers: MonitoringServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
});

async function start(
  model: MonitoringReadModel,
  opts: Partial<Parameters<typeof createMonitoringServer>[0]> = {},
): Promise<{ server: MonitoringServer; base: string }> {
  const server = createMonitoringServer({ monitoring: model, host: '127.0.0.1', port: 0, ...opts });
  servers.push(server);
  const address = await server.listen();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function position(symbol: string, quantity: string): PositionSnapshot {
  return {
    symbol,
    quantity,
    averageEntryPrice: '40000.00000000',
    costBasis: '0.00000000',
    realizedPnl: '0.00000000',
    feesPaid: '0.00000000',
    entryAnchorPrice: null,
    source: 'BOT',
    sourceQuantities: { BOT: quantity, EXTERNAL_AUTHORIZED: '0.00000000' },
  };
}

function realm(
  name: 'paper' | 'live',
  over: Partial<PortfolioRealmSnapshot> = {},
): PortfolioRealmSnapshot {
  return {
    realm: name,
    status: 'OK',
    provenance: { kind: 'managed_state', asOfMs: 1000, fetchedAtMs: 1000, stale: false },
    cash: null,
    positions: null,
    externalSnapshot: null,
    authorizedExternal: null,
    reserved: null,
    orderReservations: null,
    appliedExecutions: null,
    liveOrderAttestations: null,
    manualSettlements: null,
    peakEquity: null,
    realizedPnl: null,
    dailyRealizedPnl: null,
    dailyRealizedDayKey: null,
    totalFees: null,
    ...over,
  };
}

function order(): OrderSnapshot {
  return {
    clientOrderId: 'live-BTCCAD-1',
    exchangeOrderId: '26177556994',
    symbol: 'BTC/CAD',
    side: 'SELL',
    type: 'limit',
    status: 'FILLED',
    quantity: '0.01000000',
    filledQuantity: '0.01000000',
    averagePrice: '100000.00000000',
    limitPrice: '100000.00000000',
    fills: [],
    fee: '0.00000000',
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: 100,
    updatedAtMs: 200,
    resolution: null,
  };
}

function sampleSnapshot(): MonitoringSnapshot {
  return {
    capturedAtMs: 1_000_000,
    system: {
      capturedAtMs: 1_000_000,
      config: {
        version: '1.2.1',
        tradingMode: 'paper',
        exchange: 'ndax',
        killSwitch: false,
        enableAuthenticatedReads: false,
        strategy: 'moving-average-crossover',
        timeframe: '5m',
        tradingPairs: ['BTC/CAD'],
        universeMarkets: ['BTC/CAD'],
      },
      init: { status: 'OK', paper: true, live: true },
      lock: { held: false },
      recovery: {
        status: 'READY',
        reasons: [],
        unresolvedOrders: [],
        unresolvedReservations: [],
        unresolvedIntents: [],
        crossFileIssues: [],
        requiresExchangeRead: false,
      },
      provenance: { kind: 'derived', asOfMs: 1_000_000, fetchedAtMs: 1_000_000, stale: false },
    },
    portfolios: {
      paper: realm('paper', {
        cash: { CAD: '5000.00000000' },
        positions: [position('BTC/CAD', '0.50000000')],
      }),
      live: realm('live', {
        cash: { CAD: '1000.00000000' },
        positions: [position('ETH/CAD', '0.10000000')],
        externalSnapshot: { 'BTC/CAD': '0.20000000' },
        authorizedExternal: ['BTC/CAD'],
      }),
    },
    orders: {
      status: 'OK',
      provenance: { kind: 'managed_state', asOfMs: 1000, fetchedAtMs: 1000, stale: false },
      orders: [order()],
      unresolvedCount: 0,
      totalCount: 1,
    },
    market: {
      status: 'UNAVAILABLE',
      reason: 'no provider',
      provenance: { kind: 'unavailable', asOfMs: null, fetchedAtMs: 1000, stale: true },
      symbol: 'BTC/CAD',
      last: null,
      bid: null,
      ask: null,
      spread: null,
      spreadPct: null,
      quoteTimestampMs: null,
      observedAtMs: null,
      quoteAgeMs: null,
      transportAgeMs: null,
      stale: true,
      staleReason: 'no provider',
      lastError: null,
    },
  };
}

function sampleHealth(): HealthSnapshot {
  return {
    status: 'OK',
    provenance: { kind: 'exchange_read', asOfMs: 1, fetchedAtMs: 1, stale: false },
    authenticatedReadsEnabled: false,
    connected: true,
    latencyMs: 5,
    detail: 'ok',
    checkedAtMs: 1,
    error: null,
  };
}

function sampleReconciliation(): ReconciliationSnapshot {
  return {
    status: 'READY',
    provenance: { kind: 'derived', asOfMs: 1, fetchedAtMs: 1, stale: false },
    requestedAtMs: 1,
    result: null,
    error: null,
  };
}

interface CallCounts {
  snapshot: number;
  health: number;
  reconciliation: number;
}

function fakeModel(opts: {
  snapshot?: MonitoringSnapshot;
  health?: HealthSnapshot;
  reconciliation?: ReconciliationSnapshot;
  snapshotThrows?: boolean;
} = {}): { model: MonitoringReadModel; calls: CallCounts } {
  const calls: CallCounts = { snapshot: 0, health: 0, reconciliation: 0 };
  const model: MonitoringReadModel = {
    async getSnapshot() {
      calls.snapshot += 1;
      if (opts.snapshotThrows) throw new Error('boom at /home/brady/.state/secret.json');
      return opts.snapshot ?? sampleSnapshot();
    },
    async getHealth() {
      calls.health += 1;
      return opts.health ?? sampleHealth();
    },
    async getReconciliation() {
      calls.reconciliation += 1;
      return opts.reconciliation ?? sampleReconciliation();
    },
  };
  return { model, calls };
}

const KNOWN_PATHS = [
  '/api/healthz',
  '/api/status',
  '/api/portfolio',
  '/api/orders',
  '/api/market',
  '/api/health',
  '/api/reconciliation',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MonitoringHttpServer — read-only HTTP API', () => {
  it('1. /api/healthz returns 200 and does not call the monitoring service or NDAX', async () => {
    const { model, calls } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(calls.snapshot).toBe(0);
    expect(calls.health).toBe(0);
    expect(calls.reconciliation).toBe(0);
  });

  it('2. /api/status returns the monitoring system/status section', async () => {
    const { model, calls } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitoringSnapshot['system'];
    expect(body.config.version).toBe('1.2.1');
    expect(body.lock.held).toBe(false);
    expect(calls.snapshot).toBe(1);
    expect(calls.reconciliation).toBe(0);
  });

  it('3. /api/portfolio returns PAPER/LIVE/external/authorized separately', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/portfolio`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitoringSnapshot['portfolios'];

    expect(body.paper.positions![0]!.symbol).toBe('BTC/CAD');
    expect(body.live.positions![0]!.symbol).toBe('ETH/CAD');
    expect(body.live.externalSnapshot).toEqual({ 'BTC/CAD': '0.20000000' });
    expect(body.live.authorizedExternal).toEqual(['BTC/CAD']);
    // No aggregated/combined portfolio is ever produced.
    expect(body).not.toHaveProperty('combined');
    expect(body).not.toHaveProperty('total');
  });

  it('4. /api/orders returns the monitoring order data', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const body = (await (await fetch(`${base}/api/orders`)).json()) as MonitoringSnapshot['orders'];
    expect(body.status).toBe('OK');
    expect(body.orders![0]!.clientOrderId).toBe('live-BTCCAD-1');
    expect(body.orders![0]!.status).toBe('FILLED');
  });

  it('5. /api/market represents unavailable and stale market data without inventing values', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const unavailable = (await (await fetch(`${base}/api/market`)).json()) as MonitoringSnapshot['market'];
    expect(unavailable.status).toBe('UNAVAILABLE');
    expect(unavailable.stale).toBe(true);
    expect(unavailable.last).toBeNull();

    const staleSnapshot = sampleSnapshot();
    staleSnapshot.market = {
      ...staleSnapshot.market,
      status: 'OK',
      stale: true,
      staleReason: 'QUOTE_STALE',
      provenance: { kind: 'exchange_read', asOfMs: 5, fetchedAtMs: 1000, stale: true },
    };
    const { model: staleModel } = fakeModel({ snapshot: staleSnapshot });
    const { base: staleBase } = await start(staleModel);
    const stale = (await (await fetch(`${staleBase}/api/market`)).json()) as MonitoringSnapshot['market'];
    expect(stale.status).toBe('OK');
    expect(stale.stale).toBe(true);
    expect(stale.staleReason).toBe('QUOTE_STALE');
  });

  it('6. /api/health invokes the explicit monitoring health operation', async () => {
    const { model, calls } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthSnapshot;
    expect(body.connected).toBe(true);
    expect(calls.health).toBe(1);
    expect(calls.snapshot).toBe(0);
    expect(calls.reconciliation).toBe(0);

    const { model: errModel } = fakeModel({
      health: { ...sampleHealth(), status: 'ERROR', connected: null, error: 'unreachable' },
    });
    const { base: errBase } = await start(errModel);
    const errRes = await fetch(`${errBase}/api/health`);
    expect(errRes.status).toBe(503);
    expect(((await errRes.json()) as HealthSnapshot).status).toBe('ERROR');
  });

  it('7. /api/reconciliation invokes reconciliation only when requested and preserves HALTED', async () => {
    const { model, calls } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/reconciliation`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReconciliationSnapshot).status).toBe('READY');
    expect(calls.reconciliation).toBe(1);

    // HALTED (e.g. mutation-lock contention) is preserved, not turned into success.
    const { model: haltedModel } = fakeModel({
      reconciliation: { ...sampleReconciliation(), status: 'HALTED' },
    });
    const { base: haltedBase } = await start(haltedModel);
    const haltedRes = await fetch(`${haltedBase}/api/reconciliation`);
    expect(haltedRes.status).toBe(200);
    expect(((await haltedRes.json()) as ReconciliationSnapshot).status).toBe('HALTED');

    // UNAVAILABLE -> 503; ERROR -> 500 with a generic envelope.
    const { model: unavailModel } = fakeModel({
      reconciliation: { ...sampleReconciliation(), status: 'UNAVAILABLE', error: 'no adapter' },
    });
    const { base: unavailBase } = await start(unavailModel);
    expect((await fetch(`${unavailBase}/api/reconciliation`)).status).toBe(503);

    const { model: errorModel } = fakeModel({
      reconciliation: { ...sampleReconciliation(), status: 'ERROR', error: 'raw internal detail' },
    });
    const { base: errorBase } = await start(errorModel);
    const errorRes = await fetch(`${errorBase}/api/reconciliation`);
    expect(errorRes.status).toBe(500);
    const errorText = await errorRes.text();
    expect(errorText).not.toContain('raw internal detail');
    expect(JSON.parse(errorText).error.code).toBe('RECONCILIATION_READ_FAILED');
  });

  it('8. other endpoints never trigger reconciliation', async () => {
    const { model, calls } = fakeModel();
    const { base } = await start(model);

    for (const path of ['/api/status', '/api/portfolio', '/api/orders', '/api/market', '/api/health']) {
      await fetch(`${base}${path}`);
    }
    expect(calls.reconciliation).toBe(0);
  });

  it('9. unknown routes and traversal attempts return 404', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const traversal = await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`);
    expect(traversal.status).toBe(404);
  });

  it('10. unsupported methods return 405 with Allow: GET', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/status`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('11. internal errors return a safe structured 5xx without stack traces or paths', async () => {
    const { model } = fakeModel({ snapshotThrows: true });
    const { base } = await start(model);

    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = JSON.parse(text) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('internal error');
    expect(text).not.toContain('boom');
    expect(text).not.toContain('/home/brady/.state/secret.json');
    expect(text).not.toContain('at ');
  });

  it('11b. redacts configured local paths from responses', async () => {
    const snapshot = sampleSnapshot();
    snapshot.system.recovery.reasons = ['corrupt at /home/brady/.state/order-ledger.json'];
    const { model } = fakeModel({ snapshot });
    const { base } = await start(model, { redactPaths: ['/home/brady/.state/'] });

    const text = await (await fetch(`${base}/api/status`)).text();
    expect(text).not.toContain('/home/brady/.state/');
    expect(text).toContain('[redacted-path]');
  });

  it('12. no secrets appear in any HTTP response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retrac-api-secret-'));
    try {
      const cfg = {
        tradingMode: 'paper',
        exchange: 'ndax',
        killSwitch: false,
        enableAuthenticatedReads: false,
        strategy: 'moving-average-crossover',
        timeframe: '5m',
        tradingPairs: ['BTC/CAD'],
        universeMarkets: ['BTC/CAD'],
        marketDataMaxAgeMs: 60_000,
        marketDataTransportMaxAgeMs: 60_000,
        maxClockSkewMs: 120_000,
        ndaxApiKey: 'SECRET_API_KEY_VALUE',
        ndaxApiSecret: 'SECRET_API_SECRET_VALUE',
        ndaxUserId: 'NDAX_USER_ID_SECRET',
        ndaxUserName: 'secret-user@example.com',
        ndaxAccountId: 449,
      } as BotConfig;

      const monitoring = new MonitoringService({
        config: cfg,
        version: '1.2.1',
        orders: new OrderStore(join(dir, 'orders.json')),
        paper: new PaperStateStore(join(dir, 'paper.json')),
        live: new ManagedStateStore(join(dir, 'live.json')),
        manualIntents: new ManualIntentStore(join(dir, 'manual.json')),
        initMarker: new StateInitMarker(join(dir, '.init.json')),
        stateDir: dir,
        nowMs: () => 1_000_000,
      });
      const { base } = await start(monitoring);

      for (const path of ['/api/status', '/api/portfolio', '/api/orders', '/api/market']) {
        const text = await (await fetch(`${base}${path}`)).text();
        expect(text).not.toContain('SECRET_API_KEY_VALUE');
        expect(text).not.toContain('SECRET_API_SECRET_VALUE');
        expect(text).not.toContain('NDAX_USER_ID_SECRET');
        expect(text).not.toContain('secret-user@example.com');
      }
      // Real serialization happened: a known non-secret field is present.
      expect(await (await fetch(`${base}/api/status`)).text()).toContain('1.2.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('13. exposes no write methods or write routes', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    for (const path of KNOWN_PATHS) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET');
      }
    }

    const server = createMonitoringServer({ monitoring: model });
    const asRecord = server as unknown as Record<string, unknown>;
    for (const method of ['placeOrder', 'cancelOrder', 'settleManualOrder', 'commitProven']) {
      expect(asRecord[method]).toBeUndefined();
    }
  });

  it('13b. rejects unexpected request bodies', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/status`, { method: 'POST', body: '{"evil":true}' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('14. serializes monetary values as exact decimal strings (no floating point)', async () => {
    const { model } = fakeModel();
    const { base } = await start(model);

    const res = await fetch(`${base}/api/orders`);
    const text = await res.text();
    const body = JSON.parse(text) as MonitoringSnapshot['orders'];
    expect(typeof body.orders![0]!.quantity).toBe('string');
    expect(body.orders![0]!.quantity).toBe('0.01000000');
    expect(text).toContain('"0.01000000"');

    const portfolio = (await (await fetch(`${base}/api/portfolio`)).json()) as MonitoringSnapshot['portfolios'];
    expect(typeof portfolio.paper.cash!['CAD']).toBe('string');
    expect(portfolio.paper.cash!['CAD']).toBe('5000.00000000');
  });

  it('15. defaults to loopback binding (never 0.0.0.0)', async () => {
    const server = createMonitoringServer({ monitoring: fakeModel().model });
    expect(server.host).toBe('127.0.0.1');
    expect(DEFAULT_MONITORING_HOST).toBe('127.0.0.1');
    expect(DEFAULT_MONITORING_PORT).toBe(8787);

    // Port 0 to avoid clashing; host default provides the secure binding.
    const { base } = await start(fakeModel().model, { host: undefined, port: 0 });
    expect(base.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('16. close() stops accepting connections', async () => {
    const { server, base } = await start(fakeModel().model);
    expect((await fetch(`${base}/api/healthz`)).status).toBe(200);

    await server.close();
    await expect(fetch(`${base}/api/healthz`)).rejects.toThrow();
  });
});
