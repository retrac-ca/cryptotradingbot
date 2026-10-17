/**
 * `bot start` — start the bot honoring the configured TRADING_MODE.
 *
 * PAPER mode runs the full end-to-end paper engine (never touches a real order
 * endpoint).
 *
 * LIVE mode is deliberately hard to enable and fails closed. All of the
 * following must hold:
 *   1. TRADING_MODE=live
 *   2. REAL_FUNDS_AT_RISK=true          (also enforced by the config schema)
 *   3. ENABLE_AUTHENTICATED_READS=true  (also enforced by the config schema)
 *   4. KILL_SWITCH=false
 *   5. LIVE_AUTONOMOUS_ENABLED=true     (arms the bounded autonomous session)
 *   6. An explicit per-invocation confirmation flag: bot start --confirm-live
 * The NDAX adapter keeps `supportsOrderPlacement=false`; the armed, bounded
 * autonomous session is the explicit process-local capability that permits
 * placement. There is NO automatic first trade and no startup trade.
 */

import { loadConfig } from '../config/load.js';
import { createLogger } from '../logging/logger.js';
import type { CommandHandler } from './context.js';
import { runPaperEngine } from './run-engine.js';
import { runLiveEngine } from './run-live.js';
import type { BotConfig } from '../config/schema.js';

export const startCommand: CommandHandler = async (args): Promise<number> => {
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

  if (args.includes('--validate')) {
    // Load/validate config and exit without starting any engine (CI friendly).
    // eslint-disable-next-line no-console
    console.log(
      'Configuration OK: ' + cfg.tradingPairs.join(', ') + ' (mode ' + cfg.tradingMode.toUpperCase() + ')',
    );
    return 0;
  }

  if (cfg.tradingMode === 'live') {
    return await runLiveStart(cfg, args);
  }

  // eslint-disable-next-line no-console
  console.log('Starting cryptotradingbot in PAPER mode...');
  // eslint-disable-next-line no-console
  console.log('Trading pairs: ' + cfg.tradingPairs.join(', '));

  const logger = createLogger({ level: cfg.logLevel });
  return runPaperEngine(cfg, logger);
};

/**
 * LIVE start path. Requires the explicit `--confirm-live` flag in addition to
 * the configuration gates, and requires autonomous placement to be explicitly
 * armed (`LIVE_AUTONOMOUS_ENABLED=true`). When armed, it starts the continuous
 * `LiveEngine` with a bounded autonomous session. Every failure path returns
 * non-zero before any engine runs, so a live order can never be placed by
 * accident or on startup.
 */
async function runLiveStart(cfg: BotConfig, args: string[]): Promise<number> {
  if (!cfg.realFundsAtRisk) {
    // eslint-disable-next-line no-console
    console.error(
      'LIVE trading is enabled but REAL_FUNDS_AT_RISK is not "true".\n' +
        'Set REAL_FUNDS_AT_RISK=true to acknowledge that real orders with real funds are at risk.',
    );
    return 1;
  }

  if (!args.includes('--confirm-live')) {
    // eslint-disable-next-line no-console
    console.error(
      'LIVE trading was requested but not explicitly confirmed.\n' +
        'TRADING_MODE=live and REAL_FUNDS_AT_RISK=true are set, but the bot refuses to start.\n' +
        'Pass --confirm-live on this invocation to confirm you understand that live trading\n' +
        'places real orders with real money.\n' +
        'Refusing to start.',
    );
    return 1;
  }

  if (!cfg.liveAutonomousEnabled) {
    // eslint-disable-next-line no-console
    console.error(
      'LIVE mode requested but autonomous order placement is not armed.\n' +
        'Set LIVE_AUTONOMOUS_ENABLED=true (with TRADING_MODE=live, REAL_FUNDS_AT_RISK=true and\n' +
        'ENABLE_AUTHENTICATED_READS=true) to run the continuous autonomous engine, or use\n' +
        '`bot live-test buy|sell` for a single controlled operator-confirmed order.\n' +
        'Refusing to start.',
    );
    return 1;
  }

  // eslint-disable-next-line no-console
  console.warn(
    '\n*** AUTONOMOUS LIVE TRADING IS ARMED ***\n' +
      'The bot will trade real funds, unattended, with LIMIT-IOC orders bounded by\n' +
      `LIVE_MAX_BASE_QUANTITY=${cfg.liveMaxBaseQuantity}, LIVE_MAX_QUOTE_NOTIONAL=${cfg.liveMaxQuoteNotional}, ` +
      `and a session budget of ${cfg.liveAutonomousMaxSessionQuoteNotional} quote over ${cfg.liveAutonomousMaxSessionOrders} orders.\n` +
      'Ctrl-C stops it. KILL_SWITCH=false is required.\n',
  );

  const logger = createLogger({ level: cfg.logLevel });
  return runLiveEngine(cfg, logger);
}
