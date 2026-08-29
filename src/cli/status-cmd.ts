/**
 * `bot status` — show current bot state.
 *
 * Reports effective configuration plus any detected runtime state. In this
 * phase runtime state is minimal (the engine is not yet implemented), but the
 * command structure is in place for richer reports later.
 */

import { loadConfig } from '../config/load.js';
import type { CommandHandler } from './context.js';

export const statusCommand: CommandHandler = (): number => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('Bot status');
  // eslint-disable-next-line no-console
  console.log('  Process:        not running (engine not yet implemented in this phase)');
  // eslint-disable-next-line no-console
  console.log('  Trading mode:   ' + cfg.tradingMode.toUpperCase());
  // eslint-disable-next-line no-console
  console.log('  Kill switch:    ' + (cfg.killSwitch ? 'ENABLED (trading blocked)' : 'disabled'));
  // eslint-disable-next-line no-console
  console.log('  Exchange:       ' + cfg.exchange);
  // eslint-disable-next-line no-console
  console.log('  Pairs:          ' + cfg.tradingPairs.join(', '));
  return 0;
};
