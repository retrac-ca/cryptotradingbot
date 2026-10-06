import { describe, it, expect, vi } from 'vitest';
import { Poller } from '../../../web/src/poller.js';
import { ReconcileController } from '../../../web/src/reconcileController.js';
import { REFRESH_INTERVALS } from '../../../web/src/app.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Poller', () => {
  it('never runs the same task concurrently', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const poller = new Poller([{ key: 'status', intervalMs: 10_000, run }]);

    const first = poller.tick({ key: 'status', intervalMs: 10_000, run });
    const second = poller.tick({ key: 'status', intervalMs: 10_000, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(poller.isRunning('status')).toBe(true);

    gate.resolve();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(poller.isRunning('status')).toBe(false);
  });

  it('allows a later tick once the previous one has finished', async () => {
    const run = vi.fn(async () => {});
    const poller = new Poller([{ key: 'market', intervalMs: 5000, run }]);
    await poller.tick({ key: 'market', intervalMs: 5000, run });
    await poller.tick({ key: 'market', intervalMs: 5000, run });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps tasks independent (one slow task does not block another)', async () => {
    const gate = deferred();
    const slow = vi.fn(() => gate.promise);
    const fast = vi.fn(async () => {});
    const poller = new Poller([
      { key: 'slow', intervalMs: 1000, run: slow },
      { key: 'fast', intervalMs: 1000, run: fast },
    ]);
    await poller.tick({ key: 'fast', intervalMs: 1000, run: fast });
    expect(fast).toHaveBeenCalledTimes(1);
    expect(slow).not.toHaveBeenCalled();
    gate.resolve();
  });

  it('stops all timers on stop()', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => {});
      const poller = new Poller([{ key: 'status', intervalMs: 1000, run }]);
      poller.start();
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(run).toHaveBeenCalledTimes(4);
      poller.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dashboard refresh policy', () => {
  it('polls only snapshot endpoints at the documented intervals', () => {
    expect(REFRESH_INTERVALS).toEqual({
      status: 10_000,
      portfolio: 10_000,
      orders: 10_000,
      market: 5_000,
      health: 30_000,
      healthz: 10_000,
    });
  });

  it('never schedules reconciliation for automatic polling', () => {
    expect(Object.keys(REFRESH_INTERVALS)).not.toContain('reconciliation');
  });
});

describe('ReconcileController', () => {
  it('runs an explicit request', async () => {
    const run = vi.fn(async () => {});
    const controller = new ReconcileController(run);
    const started = await controller.request();
    expect(started).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping requests (never runs two at once)', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const controller = new ReconcileController(run);

    const first = controller.request();
    const second = await controller.request();
    expect(second).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.isPending).toBe(true);

    gate.resolve();
    expect(await first).toBe(true);
    expect(controller.isPending).toBe(false);
  });

  it('does not retry automatically', async () => {
    const run = vi.fn(async () => {});
    const controller = new ReconcileController(run);
    await controller.request();
    await new Promise((r) => setTimeout(r, 20));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
