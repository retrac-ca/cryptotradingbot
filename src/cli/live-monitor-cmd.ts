/**
 * `bot live-monitor` — a bounded, READ-ONLY lifecycle observer for unresolved
 * LIVE orders.
 *
 * This is NOT a live-trading command. It ONLY:
 *   - observes the durable order ledger for unresolved LIVE orders,
 *   - queries NDAX read-only (order status / account trades / market info),
 *   - advances local order state on verified exchange evidence,
 *   - applies PROVEN, quote-fee executions via the existing idempotent path,
 *   - releases a reservation only when the existing proven-terminal rules allow.
 *
 * It NEVER submits or cancels an order, NEVER retries an ambiguous submission,
 * NEVER creates a replacement order, and does NOT enable autonomous live trading
 * (`supportsOrderPlacement` remains false). The exchange adapter is wrapped in a
 * read-only proxy so no code path can reach an exchange write method.
 */

import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { OrderStore, ManagedStateStore } from '../persistence/index.js';
import { LiveOrderMonitor } from '../execution/index.js';
import type { LiveMonitorReport } from '../execution/index.js';
import { toReadOnlyAdapter } from './manual-cmd.js';
import type { CommandHandler } from './context.js';

/** Minimum allowed monitor interval (seconds) — conservative polling floor. */
const MIN_MONITOR_INTERVAL_SECONDS = 5;

/**
 * Dependencies for the monitor session. Split out from the CLI handler so the
 * periodic scheduling can be exercised in tests without constructing a live
 * adapter or performing any network I/O.
 */
export interface LiveMonitorSessionDeps {
  /** Perform one READ-ONLY monitoring pass. Must never submit/cancel/retry. */
  monitorOnce: () => Promise<LiveMonitorReport>;
  /** Polling interval in milliseconds (already clamped by the caller). */
  intervalMs: number;
  /**
   * Register the shutdown callback. Defaults to `process` SIGINT/SIGTERM.
   * Injectable so tests can stop the session deterministically.
   */
  registerShutdown?: (handler: () => void) => void;
}

/**
 * Run the monitor session: one immediate READ-ONLY cycle, then one cycle per
 * interval until shutdown.
 *
 * `running` is the shutdown flag and starts `true` so scheduled cycles execute;
 * it is cleared on shutdown. `cycleRunning` prevents overlapping cycles (a slow
 * cycle causes the next tick to be skipped, not queued). A cycle failure is
 * caught and the loop waits for the next cycle (fail closed). The only exchange
 * interaction is the injected `monitorOnce`; this function never submits,
 * cancels, retries, or reprices.
 */
export async function runLiveMonitorSession(deps: LiveMonitorSessionDeps): Promise<void> {
  let running = true;
  let cycleRunning = false;
  const runCycle = async (): Promise<void> => {
    if (cycleRunning) return; // no overlapping cycles
    cycleRunning = true;
    try {
      const report = await deps.monitorOnce();
      // eslint-disable-next-line no-console
      console.log(
        `live-monitor cycle complete: checked=${report.checkedOrders.length} ` +
          `transitions=${report.transitions.length} applied=${report.appliedExecutions.length} ` +
          `unresolved=${report.unresolved.length} released=${report.releasedReservations.length} ` +
          `errors=${report.errors.length}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('live-monitor cycle failed (fail closed, wait for next cycle): ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      cycleRunning = false;
    }
  };

  await runCycle();

  const timer = setInterval(() => {
    if (!running) return;
    void runCycle();
  }, deps.intervalMs);
  if (timer.unref) timer.unref();

  await new Promise<void>((resolve) => {
    const onSignal = () => {
      running = false;
      clearInterval(timer);
      // eslint-disable-next-line no-console
      console.log('\nlive-monitor stopped.');
      resolve();
    };
    if (deps.registerShutdown) {
      deps.registerShutdown(onSignal);
    } else {
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    }
  });
}

export const liveMonitorCommand: CommandHandler = async (_args): Promise<number> => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  if (!cfg.enableAuthenticatedReads) {
    // eslint-disable-next-line no-console
    console.error('The live monitor needs authenticated account reads, but ENABLE_AUTHENTICATED_READS is not "true".');
    return 1;
  }

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  let adapter: ExchangeAdapter;
  try {
    adapter = createExchange(cfg.exchange, { credentials, config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Could not construct the exchange adapter:\n' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const readOnly = toReadOnlyAdapter(adapter);
  const monitor = new LiveOrderMonitor({
    stateDir: cfg.stateDir,
    orders: new OrderStore(cfg.orderLedgerFile),
    live: new ManagedStateStore(cfg.liveManagedStateFile),
    adapter: readOnly,
  });

  const intervalMs = Math.max(
    MIN_MONITOR_INTERVAL_SECONDS,
    cfg.liveMonitorIntervalSeconds ?? 30,
  ) * 1000;

  // eslint-disable-next-line no-console
  console.log('Starting READ-ONLY live order lifecycle monitor...');
  // eslint-disable-next-line no-console
  console.log(`  interval: ${intervalMs / 1000}s | mode: READ-ONLY (no submit/cancel)`);
  // eslint-disable-next-line no-console
  console.log('  NDAX autonomous order placement remains DISABLED (supportsOrderPlacement=false).');

  await runLiveMonitorSession({
    monitorOnce: () => monitor.monitorOnce(),
    intervalMs,
  });

  return 0;
};
