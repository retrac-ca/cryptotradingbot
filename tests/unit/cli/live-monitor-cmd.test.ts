import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLiveMonitorSession } from '../../../src/cli/live-monitor-cmd.js';
import type { LiveMonitorReport } from '../../../src/execution/index.js';

function emptyReport(): LiveMonitorReport {
  return {
    checkedOrders: [],
    transitions: [],
    appliedExecutions: [],
    unresolved: [],
    releasedReservations: [],
    errors: [],
  };
}

/**
 * `bot live-monitor` periodic scheduling.
 *
 * Regression: the session initialized its `running` shutdown flag to `false`
 * and never set it true, so the interval guard (`if (!running) return`) skipped
 * every scheduled cycle. Only the initial cycle ever ran. These tests prove a
 * SECOND and subsequent scheduled cycle actually executes, and that a slow
 * cycle does not overlap.
 */
describe('bot live-monitor — periodic cycle scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the initial cycle and each subsequent scheduled cycle', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let cycles = 0;
    let shutdown: (() => void) | undefined;
    const session = runLiveMonitorSession({
      monitorOnce: async () => {
        cycles += 1;
        return emptyReport();
      },
      intervalMs: 1000,
      registerShutdown: (handler) => {
        shutdown = handler;
      },
    });

    // The initial cycle runs before the interval is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles).toBe(1);

    // A scheduled tick must run a SECOND cycle (this is the regression: the
    // dead `running` guard made every later tick return immediately).
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycles).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(cycles).toBe(3);

    // Clean shutdown stops further cycles.
    expect(shutdown).toBeTypeOf('function');
    shutdown!();
    await session;
    await vi.advanceTimersByTimeAsync(5000);
    expect(cycles).toBe(3);
  });

  it('skips a scheduled tick while a prior cycle is still running (no overlap)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let cycles = 0;
    const resolvers: Array<() => void> = [];
    let shutdown: (() => void) | undefined;
    const session = runLiveMonitorSession({
      monitorOnce: () => {
        cycles += 1;
        return new Promise<LiveMonitorReport>((resolve) => {
          resolvers.push(() => resolve(emptyReport()));
        });
      },
      intervalMs: 1000,
      registerShutdown: (handler) => {
        shutdown = handler;
      },
    });

    // Initial cycle starts and stays pending.
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles).toBe(1);
    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);

    // Second cycle starts and is left pending.
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycles).toBe(2);

    // The next tick fires while cycle 2 is still pending: it must be skipped.
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycles).toBe(2);

    resolvers[1]!();
    await vi.advanceTimersByTimeAsync(0);

    shutdown!();
    await session;
  });

  it('keeps running after a cycle failure (fail closed, wait for next cycle)', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let cycles = 0;
    let shutdown: (() => void) | undefined;
    const session = runLiveMonitorSession({
      monitorOnce: async () => {
        cycles += 1;
        if (cycles === 1) throw new Error('simulated read failure');
        return emptyReport();
      },
      intervalMs: 1000,
      registerShutdown: (handler) => {
        shutdown = handler;
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(cycles).toBe(1);
    expect(errorSpy).toHaveBeenCalled();

    // The failed initial cycle must not stop the loop.
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycles).toBe(2);

    shutdown!();
    await session;
  });
});
