/**
 * `bot start` — start the bot.
 *
 * Honors the configured TRADING_MODE. The full trading engine (strategy, risk,
 * execution, market data) is implemented in later phases; for now this
 * validates configuration and prints a clear status so users get immediate,
 * readable feedback.
 */

import { loadConfig } from '../config/load.js';
import type { CommandHandler } from './context.js';

export const startCommand: CommandHandler = (): number => {
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
  console.log('Starting cryptotradingbot in ' + cfg.tradingMode.toUpperCase() + ' mode...');
  // eslint-disable-next-line no-console
  console.log('Trading pairs: ' + cfg.tradingPairs.join(', '));
  // eslint-disable-next-line no-console
  console.log('\n[INFO] The trading engine is not yet implemented in this phase.');
  // eslint-disable-next-line no-console
  console.log('Run "bot status" for current state.');
  return 0;
};
