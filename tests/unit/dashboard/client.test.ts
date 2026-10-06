import { describe, it, expect, vi } from 'vitest';
import { ApiClient, DEFAULT_TIMEOUT_MS } from '../../../web/src/client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('dashboard ApiClient', () => {
  it('requests relative API paths and never a hard-coded origin', async () => {
    const paths: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const client = new ApiClient({ fetchFn });
    await client.getStatus();
    await client.getPortfolio();
    await client.getOrders();
    await client.getMarket();
    await client.getHealth();
    await client.getHealthz();
    await client.getReconciliation();

    expect(paths).toEqual([
      '/api/status',
      '/api/portfolio',
      '/api/orders',
      '/api/market',
      '/api/health',
      '/api/healthz',
      '/api/reconciliation',
    ]);
    for (const path of paths) {
      expect(path).not.toMatch(/https?:\/\//);
      expect(path).not.toContain('127.0.0.1');
      expect(path).not.toContain('localhost');
    }
  });

  it('returns non-2xx responses with their parsed body (honest state)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          status: 'UNAVAILABLE',
          provenance: { kind: 'unavailable', asOfMs: null, fetchedAtMs: 1, stale: false },
          requestedAtMs: 1,
          result: null,
          error: 'no adapter',
        },
        503,
      ),
    ) as unknown as typeof fetch;

    const client = new ApiClient({ fetchFn });
    const result = await client.getReconciliation();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect((result.data as { status: string }).status).toBe('UNAVAILABLE');
  });

  it('surfaces a safe error message for API error envelopes', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } }, 500),
    ) as unknown as typeof fetch;

    const client = new ApiClient({ fetchFn });
    const result = await client.getStatus();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBe('internal error');
  });

  it('reports transport failures without throwing', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;

    const client = new ApiClient({ fetchFn });
    const result = await client.getStatus();
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('request failed');
  });

  it('reports invalid JSON without throwing', async () => {
    const fetchFn = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as unknown as typeof fetch;

    const client = new ApiClient({ fetchFn });
    const result = await client.getStatus();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid response');
  });

  it('keeps monetary values as exact strings (no numeric coercion)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        amount: '0.01000000',
        big: '123456789012345678901234567890.12345678',
      }),
    ) as unknown as typeof fetch;
    const client = new ApiClient({ fetchFn });
    const result = await client.get<Record<string, unknown>>('/api/portfolio');
    expect(typeof result.data!.amount).toBe('string');
    expect(result.data!.amount).toBe('0.01000000');
    expect(result.data!.big).toBe('123456789012345678901234567890.12345678');

    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../../web/src/client.ts', import.meta.url), 'utf8'),
    );
    // The client must never parse money with Number()/parseFloat.
    expect(src).not.toMatch(/Number\s*\(/);
    expect(src).not.toMatch(/parseFloat/);
  });

  it('exposes a sane default timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
