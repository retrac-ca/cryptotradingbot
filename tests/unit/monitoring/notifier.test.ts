import { describe, expect, it, vi } from 'vitest';
import { createNotifier, NULL_NOTIFIER } from '../../../src/monitoring/notifier.js';

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('notifier — best-effort alerting', () => {
  it('returns the null notifier when nothing is configured', () => {
    expect(createNotifier({})).toBe(NULL_NOTIFIER);
  });

  it('POSTs a JSON webhook for an alert', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const n = createNotifier({ webhookUrl: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch, source: 'test' });
    n.notify({ kind: 'HALTED', detail: 'kill switch', atMs: 1000 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ source: 'test', kind: 'HALTED', detail: 'kill switch' });
  });

  it('debounces repeated identical alerts within the interval', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const n = createNotifier({ webhookUrl: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 10_000 });
    n.notify({ kind: 'UNKNOWN_ORDER', detail: 'x', atMs: 1000 });
    n.notify({ kind: 'UNKNOWN_ORDER', detail: 'x', atMs: 2000 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A different detail is not debounced.
    n.notify({ kind: 'UNKNOWN_ORDER', detail: 'y', atMs: 3000 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never throws into the engine when delivery fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const n = createNotifier({ webhookUrl: 'https://example.test/hook', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(() => n.notify({ kind: 'CYCLE_ERROR', detail: 'boom', atMs: 1 })).not.toThrow();
    await flush();
  });
});
