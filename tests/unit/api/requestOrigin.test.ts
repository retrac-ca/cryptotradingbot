import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import {
  createMonitoringServer,
  DEFAULT_ALLOWED_HOSTS,
  evaluateRequestOrigin,
  isHostAllowed,
} from '../../../src/api/index.js';
import type { MonitoringReadModel, MonitoringServer } from '../../../src/api/index.js';

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

interface CallCounts {
  snapshot: number;
  health: number;
  reconciliation: number;
}

function fakeModel(): { model: MonitoringReadModel; calls: CallCounts } {
  const calls: CallCounts = { snapshot: 0, health: 0, reconciliation: 0 };
  const model: MonitoringReadModel = {
    async getSnapshot() {
      calls.snapshot += 1;
      return {} as never;
    },
    async getHealth() {
      calls.health += 1;
      return { status: 'OK' } as never;
    },
    async getReconciliation() {
      calls.reconciliation += 1;
      return { status: 'READY' } as never;
    },
  };
  return { model, calls };
}

async function start(
  model: MonitoringReadModel,
  allowedHosts?: readonly string[],
): Promise<number> {
  const server = createMonitoringServer({
    monitoring: model,
    host: '127.0.0.1',
    port: 0,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  servers.push(server);
  const address = await server.listen();
  return address.port;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** HTTP request with a fully explicit Host header (no auto Host). */
function send(
  port: number,
  opts: { path?: string; method?: string; host?: string | null; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.host !== null) headers.Host = opts.host ?? `127.0.0.1:${port}`;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers,
        setHost: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Raw HTTP/1.0 request (used to omit the Host header entirely). */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(data);
    });
  });
}

// ---------------------------------------------------------------------------
// Pure validation helpers
// ---------------------------------------------------------------------------

describe('isHostAllowed / evaluateRequestOrigin (pure)', () => {
  it('accepts allowlisted hostnames with and without ports', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:8787', 'localhost', 'localhost:8787', '::1', '[::1]:8787']) {
      expect(isHostAllowed(host), host).toBe(true);
    }
  });

  it('rejects non-allowlisted, malformed, and missing hosts', () => {
    for (const host of [
      undefined,
      '',
      'evil.example',
      'evil.example:8787',
      '127.0.0.2:8787',
      '192.168.1.10:8787',
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      'bad:host:extra',
      '[::1',
      'localhost:notaport',
      'localhost:99999',
    ]) {
      expect(isHostAllowed(host as string | undefined), String(host)).toBe(false);
    }
  });

  it('does not do substring/suffix matching', () => {
    expect(isHostAllowed('x127.0.0.1')).toBe(false);
    expect(isHostAllowed('127.0.0.1.nip.io')).toBe(false);
    expect(isHostAllowed('[::1]:8787')).toBe(true);
  });

  it('allows an explicitly configured tailnet hostname', () => {
    const allowed = [...DEFAULT_ALLOWED_HOSTS, 'machine.tailnet.ts.net'];
    expect(isHostAllowed('machine.tailnet.ts.net', allowed)).toBe(true);
    expect(isHostAllowed('machine.tailnet.ts.net:443', allowed)).toBe(true);
    expect(isHostAllowed('other.tailnet.ts.net', allowed)).toBe(false);
  });

  it('rejects cross-site and foreign origins, allows same-origin/absent', () => {
    const allowed = DEFAULT_ALLOWED_HOSTS;
    expect(evaluateRequestOrigin({ host: '127.0.0.1:8787' }, allowed).allowed).toBe(true);
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', secFetchSite: 'same-origin' }, allowed).allowed,
    ).toBe(true);
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', secFetchSite: 'same-site' }, allowed).allowed,
    ).toBe(true);
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', secFetchSite: 'none' }, allowed).allowed,
    ).toBe(true);
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', secFetchSite: 'cross-site' }, allowed),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', origin: 'http://evil.example' }, allowed),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(
      evaluateRequestOrigin({ host: '127.0.0.1:8787', origin: 'null' }, allowed),
    ).toMatchObject({ allowed: false, status: 403 });
    expect(
      evaluateRequestOrigin(
        { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' },
        allowed,
      ).allowed,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server integration — Host allowlist
// ---------------------------------------------------------------------------

describe('MonitoringHttpServer — Host allowlist', () => {
  it('allows 127.0.0.1 and localhost with the port', async () => {
    const { model } = fakeModel();
    const port = await start(model);
    expect((await send(port, { path: '/api/healthz', host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await send(port, { path: '/api/healthz', host: `localhost:${port}` })).status).toBe(200);
  });

  it('rejects arbitrary, LAN, and suffix hosts with 421 without calling the model', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    for (const host of ['evil.example', 'evil.example:8787', '127.0.0.2:8787', '192.168.1.10:8787', '127.0.0.1.evil.example']) {
      const res = await send(port, { path: '/api/status', host });
      expect(res.status, host).toBe(421);
      expect(JSON.parse(res.body).error.code).toBe('MISDIRECTED_REQUEST');
    }
    expect(calls.snapshot).toBe(0);
  });

  it('rejects a missing Host header safely (400) without crashing', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    const response = await raw(port, 'GET /api/status HTTP/1.0\r\n\r\n');
    expect(response).toContain(' 400 ');
    expect(calls.snapshot).toBe(0);
  });

  it('rejects a malformed Host header with 400 without calling the model', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    const res = await send(port, { path: '/api/status', host: 'bad:host:extra' });
    expect(res.status).toBe(400);
    expect(calls.snapshot).toBe(0);
  });

  it('honours a custom configured allowlist', async () => {
    const { model } = fakeModel();
    const port = await start(model, ['dashboard.example']);
    expect((await send(port, { path: '/api/healthz', host: 'dashboard.example' })).status).toBe(200);
    expect((await send(port, { path: '/api/healthz', host: '127.0.0.1' })).status).toBe(421);
  });
});

// ---------------------------------------------------------------------------
// Server integration — cross-site protection
// ---------------------------------------------------------------------------

describe('MonitoringHttpServer — cross-site protection', () => {
  it('rejects cross-site requests to sensitive endpoints before any work', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    const recon = await send(port, {
      path: '/api/reconciliation',
      host: `127.0.0.1:${port}`,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(recon.status).toBe(403);
    expect(calls.reconciliation).toBe(0);

    const health = await send(port, {
      path: '/api/health',
      host: `127.0.0.1:${port}`,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(health.status).toBe(403);
    expect(calls.health).toBe(0);
  });

  it('rejects a foreign Origin before any work', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    const res = await send(port, {
      path: '/api/reconciliation',
      host: `127.0.0.1:${port}`,
      headers: { Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(calls.reconciliation).toBe(0);
  });

  it('allows same-origin, same-site, none, matching Origin, and headerless requests', async () => {
    const { model, calls } = fakeModel();
    const port = await start(model);
    const base = { path: '/api/status', host: `127.0.0.1:${port}` };
    expect((await send(port, { ...base, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
    expect((await send(port, { ...base, headers: { 'Sec-Fetch-Site': 'same-site' } })).status).toBe(200);
    expect((await send(port, { ...base, headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(200);
    expect((await send(port, { ...base, headers: { Origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
    expect((await send(port, base)).status).toBe(200); // curl-like: no browser headers
    expect(calls.snapshot).toBe(5);
  });

  it('still enforces GET-only for allowed origins', async () => {
    const { model } = fakeModel();
    const port = await start(model);
    const res = await send(port, { path: '/api/status', method: 'POST', host: `127.0.0.1:${port}` });
    expect(res.status).toBe(405);
  });
});
