/**
 * CLI entrypoint.
 *
 * Command dispatcher for the `bot` binary. Each subcommand is a small module.
 * Commands cover setup/config, paper+start engines, status, backtesting, the
 * order ledger (trades), and read-only reconciliation.
 */

import { createLogger } from '../logging/logger.js';
import { backtestCommand } from './backtest-cmd.js';
import { configureCommand } from './config-cmd.js';
import { liveMonitorCommand } from './live-monitor-cmd.js';
import { liveOnboardExternalCommand } from './live-onboard-external-cmd.js';
import { liveTestCommand } from './live-test-cmd.js';
import { manualCommand } from './manual-cmd.js';
import { paperCommand } from './paper-cmd.js';
import { reconcileCommand } from './reconcile-cmd.js';
import { resolveLiveOrderCommand } from './resolve-live-order-cmd.js';
import { setupCommand } from './setup-cmd.js';
import { startCommand } from './start-cmd.js';
import { statusCommand } from './status-cmd.js';
import { tradesCommand } from './trades-cmd.js';

export const COMMANDS = {
  setup: setupCommand,
  config: configureCommand,
  paper: paperCommand,
  start: startCommand,
  status: statusCommand,
  backtest: backtestCommand,
  trades: tradesCommand,
  reconcile: reconcileCommand,
  'live-test': liveTestCommand,
  'live-monitor': liveMonitorCommand,
  'live-onboard-external': liveOnboardExternalCommand,
  manual: manualCommand,
  'resolve-live-order': resolveLiveOrderCommand,
} as const;

export type CommandName = keyof typeof COMMANDS;

const USAGE = `cryptotradingbot v${'0.0.1'}

Usage: bot <command> [options]

Commands:
  setup     Create/configure the .env file interactively
  config    Show the effective resolved (non-secret) configuration
  paper     Start the bot in PAPER (simulated) trading mode
  start     Start the bot (paper by default)
  status    Show current bot / trading status
  backtest  Run a historical backtest from a candles JSON file
  trades    Show the durable order ledger
  reconcile Reconcile the order ledger against the exchange (read-only)
  live-test One-shot, operator-gated LIVE SELL (e.g. first-risk-validated live order)
  live-monitor READ-ONLY lifecycle observer for unresolved LIVE orders (never submits/cancels)
  live-onboard-external Authorize existing EXTERNAL exchange inventory as bot-managed (local ownership only; NOT trading)
  manual    Constrained MANUAL EXECUTION BRIDGE (operator interface; never places/cancels an exchange order)
  resolve-live-order Operator-attested resolution of an ambiguous FILLED live order (never submits/cancels)
  help      Show this help

Run "bot <command> --help" for command-specific options.
`;

export function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(USAGE);
}

export async function run(argv: string[]): Promise<number> {
  const logger = createLogger();
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return 0;
  }

  const handler = COMMANDS[command as CommandName];
  if (!handler) {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: "${command}"\n`);
    printUsage();
    return 1;
  }

  try {
    return await handler(rest, { logger });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`error: ${message}`);
    logger.error({ err }, 'command failed');
    return 1;
  }
}
