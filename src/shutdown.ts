/**
 * Graceful shutdown coordination.
 *
 * Registers SIGINT/SIGTERM handlers that call a synchronous cleanup callback
 * and resolve a once-promise. Returns an `await`able so the main program can
 * block until a shutdown signal arrives, then run finalization before exiting.
 */

export interface Shutdown {
  /** Await until a shutdown signal is received, then run cleanup once. */
  waitAndFinalize(cleanup: () => void): Promise<void>;
  /** Trigger a clean shutdown programmatically (e.g. from a stop command). */
  requestShutdown(): void;
}

export function createShutdown(): Shutdown {
  let stopping = false;
  let resolveShutdown: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const finalize = (sig: string) => {
    if (stopping) return;
    stopping = true;
    resolveShutdown?.();
    void sig;
  };

  process.once('SIGINT', () => finalize('SIGINT'));
  process.once('SIGTERM', () => finalize('SIGTERM'));

  return {
    async waitAndFinalize(cleanup) {
      await done;
      try {
        cleanup();
      } finally {
        // Give finalization a beat.
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    requestShutdown() {
      if (!stopping) {
        stopping = true;
        resolveShutdown?.();
      }
    },
  };
}
