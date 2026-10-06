import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitoringServer, StaticAssets } from '../../../src/api/index.js';
import type {
  MonitoringReadModel,
  MonitoringServer,
  MonitoringServerDeps,
} from '../../../src/api/index.js';

const servers: MonitoringServer[] = [];
let dir: string;
let outside: string;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retrac-static-'));
  outside = mkdtempSync(join(tmpdir(), 'retrac-outside-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>dashboard</h1>');
  writeFileSync(join(dir, 'styles.css'), 'body { color: red; }');
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(dir, 'notes.ts'), 'export const secret = 1;');
  writeFileSync(join(dir, 'app.js.map'), '{}');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret');
  mkdirSync(join(dir, 'views'), { recursive: true });
  writeFileSync(join(dir, 'views', 'panel.js'), 'export const panel = 1;');
});

function fakeModel(): MonitoringReadModel {
  return {
    async getSnapshot() {
      return {
        capturedAtMs: 1,
        system: {} as never,
        portfolios: {} as never,
        orders: {} as never,
        market: {} as never,
      };
    },
    async getHealth() {
      return {} as never;
    },
    async getReconciliation() {
      return {} as never;
    },
  };
}

async function start(opts: Partial<MonitoringServerDeps> = {}): Promise<string> {
  const server = createMonitoringServer({ monitoring: fakeModel(), host: '127.0.0.1', port: 0, ...opts });
  servers.push(server);
  const address = await server.listen();
  return `http://127.0.0.1:${address.port}`;
}

describe('StaticAssets — confinement', () => {
  it('serves index.html for the root path', async () => {
    const assets = new StaticAssets(dir);
    const asset = await assets.read('/');
    expect(asset).not.toBeNull();
    expect(asset!.contentType).toBe('text/html; charset=utf-8');
    expect(asset!.body.toString('utf8')).toContain('dashboard');
  });

  it('serves nested assets with the right content type', async () => {
    const assets = new StaticAssets(dir);
    const asset = await assets.read('/views/panel.js');
    expect(asset!.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('rejects path traversal (plain and percent-encoded)', async () => {
    const assets = new StaticAssets(dir);
    for (const path of [
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/views/../../package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
    ]) {
      expect(await assets.read(path)).toBeNull();
    }
  });

  it('rejects dotfiles and non-allowlisted extensions', async () => {
    const assets = new StaticAssets(dir);
    for (const path of ['/.env', '/.git/config', '/notes.ts', '/app.js.map', '/../rct', '/']) {
      if (path === '/') continue;
      expect(await assets.read(path)).toBeNull();
    }
  });

  it('rejects symlinks that point outside the root', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'escape.js'));
    const assets = new StaticAssets(dir);
    expect(await assets.read('/escape.js')).toBeNull();
  });

  it('rejects null bytes, backslashes, and missing files', async () => {
    const assets = new StaticAssets(dir);
    expect(await assets.read('/app.js%00.png')).toBeNull();
    expect(await assets.read('/..\\app.js')).toBeNull();
    expect(await assets.read('/missing.js')).toBeNull();
  });
});

describe('MonitoringHttpServer — static serving integration', () => {
  it('serves the dashboard at / and assets, while /api/* stays API-only', async () => {
    const base = await start({ staticAssets: new StaticAssets(dir) });

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('dashboard');

    const css = await fetch(`${base}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    // API routes are unaffected by static assets.
    const status = await fetch(`${base}/api/does-not-exist`);
    expect(status.status).toBe(404);
    expect(((await status.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('returns 404 for unknown static paths and never serves blocked files', async () => {
    const base = await start({ staticAssets: new StaticAssets(dir) });
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/.env`)).status).toBe(404);
    expect((await fetch(`${base}/notes.ts`)).status).toBe(404);
  });

  it('rejects non-GET/HEAD methods on static paths with Allow: GET, HEAD', async () => {
    const base = await start({ staticAssets: new StaticAssets(dir) });
    const res = await fetch(`${base}/styles.css`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('supports HEAD requests without a body', async () => {
    const base = await start({ staticAssets: new StaticAssets(dir) });
    const res = await fetch(`${base}/styles.css`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).not.toBeNull();
  });

  it('returns 404 for static paths when no static root is configured', async () => {
    const base = await start({});
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});
