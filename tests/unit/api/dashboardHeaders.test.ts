import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitoringServer, StaticAssets } from '../../../src/api/index.js';
import type { MonitoringReadModel, MonitoringServer } from '../../../src/api/index.js';

const servers: MonitoringServer[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retrac-hdr-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>dashboard</h1>');
  writeFileSync(join(dir, 'styles.css'), 'body { color: red; }');
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function fakeModel(): MonitoringReadModel {
  return {
    async getSnapshot() {
      return {} as never;
    },
    async getHealth() {
      return { status: 'OK' } as never;
    },
    async getReconciliation() {
      return { status: 'READY' } as never;
    },
  };
}

async function start(): Promise<string> {
  const server = createMonitoringServer({
    monitoring: fakeModel(),
    host: '127.0.0.1',
    port: 0,
    staticAssets: new StaticAssets(dir),
  });
  servers.push(server);
  const address = await server.listen();
  return `http://127.0.0.1:${address.port}`;
}

describe('dashboard HTML security headers', () => {
  it('sets a restrictive CSP and X-Frame-Options on HTML responses', async () => {
    const base = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets the same document headers on HEAD', async () => {
    const base = await start();
    const res = await fetch(`${base}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('does not apply HTML-only headers to non-HTML static assets', async () => {
    const base = await start();
    const res = await fetch(`${base}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('does not apply HTML-only headers to API JSON responses', async () => {
    const base = await start();
    const res = await fetch(`${base}/api/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
