/**
 * `bot paper` — start the bot in PAPER trading mode.
 *
 * Forces paper mode (never touches real order endpoints) and runs the full
 * end-to-end paper engine: market data → strategy → risk → paper execution →
 * portfolio → logging/persistence, until signaled to stop.
 *
 * Options:
 *   --validate   Load and validate configuration, then exit without starting
 *                the engine (used for CI / config checking).
 */

import { loadConfig } from '../config/load.js';
import { createLogger } from '../logging/logger.js';
import type { CommandHandler } from './context.js';
import { runPaperEngine } from './run-engine.js';

export const paperCommand: CommandHandler = async (args): Promise<number> => {
  const validateOnly = args.includes('--validate');

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  if (cfg.killSwitch) {
    // eslint-disable-next-line no-console
    console.error('Cannot start: KILL_SWITCH is enabled. Set KILL_SWITCH=false to start.');
    return 1;
  }

  if (validateOnly) {
    // eslint-disable-next-line no-console
    console.log('Paper configuration OK: ' + cfg.tradingPairs.join(', '));
    return 0;
  }

  // eslint-disable-next-line no-console
  console.log('Starting cryptotradingbot in PAPER (simulated) mode.');
  // eslint-disable-next-line no-console
  console.log('Trading pairs: ' + cfg.tradingPairs.join(', '));
  // eslint-disable-next-line no-console
  console.log('Paper starting balance: ' + cfg.paperStartingBalance + ' (quote)');

  const logger = createLogger({ level: cfg.logLevel });
  return runPaperEngine(cfg, logger);
};
