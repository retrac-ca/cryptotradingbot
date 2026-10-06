/**
 * Minimal polling scheduler.
 *
 * Guarantees:
 *   - a task never runs concurrently with itself (the next interval is skipped
 *     while a request for that task is still in flight);
 *   - `stop()` clears all timers;
 *   - tasks run independently, so one failing task never blocks the others.
 *
 * Reconciliation is intentionally NOT registered here; it is driven only by
 * explicit user action (see ReconcileController).
 */

export interface PollTask {
  key: string;
  intervalMs: number;
  run: () => Promise<void> | void;
}

export class Poller {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private started = false;

  constructor(private readonly tasks: readonly PollTask[]) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks) {
      void this.tick(task);
      const timer = setInterval(() => {
        void this.tick(task);
      }, task.intervalMs);
      this.timers.set(task.key, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.started = false;
  }

  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Run one task immediately unless it is already in flight. */
  async tick(task: PollTask): Promise<void> {
    if (this.inFlight.has(task.key)) return;
    this.inFlight.add(task.key);
    try {
      await task.run();
    } finally {
      this.inFlight.delete(task.key);
    }
  }
}
