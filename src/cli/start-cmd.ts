/**
 * `bot start` — start the bot honoring the configured TRADING_MODE.
 *
 * Only PAPER mode is implemented. LIVE mode is not yet available and fails
 * closed rather than risking real orders. PAPER mode runs the full end-to-end
 * paper engine.
 */

import { loadConfig } from '../config/load.js';
import { createLogger } from '../logging/logger.js';
import type { CommandHandler } from './context.js';
import { runPaperEngine } from './run-engine.js';

export const startCommand: CommandHandler = async (): Promise<number> => {
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

  if (cfg.tradingMode !== 'paper') {
    // eslint-disable-next-line no-console
    console.error('LIVE trading is not implemented yet. Use "bot paper" to run in PAPER mode.');
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('Starting cryptotradingbot in PAPER mode...');
  // eslint-disable-next-line no-console
  console.log('Trading pairs: ' + cfg.tradingPairs.join(', '));

  const logger = createLogger({ level: cfg.logLevel });
  return runPaperEngine(cfg, logger);
};
