/**
 * `bot paper` — start the bot in PAPER trading mode.
 *
 * This ignores TRADING_MODE in config and forces paper mode, so it is always
 * safe (never touches real order endpoints). This is the recommended way to
 * experiment.
 */

import { loadConfig } from '../config/load.js';
import type { CommandHandler } from './context.js';

export const paperCommand: CommandHandler = (): number => {
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

  // eslint-disable-next-line no-console
  console.log('Starting cryptotradingbot in PAPER (simulated) mode.');
  // eslint-disable-next-line no-console
  console.log('Trading pairs: ' + cfg.tradingPairs.join(', '));
  // eslint-disable-next-line no-console
  console.log('Paper starting balance: ' + cfg.paperStartingBalance + ' (quote)');
  // eslint-disable-next-line no-console
  console.log('\n[INFO] The simulated trading engine is not yet implemented in this phase.');
  // eslint-disable-next-line no-console
  console.log('Run "bot status" for current state.');
  return 0;
};
