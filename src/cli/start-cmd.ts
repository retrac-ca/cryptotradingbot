/**
 * `bot start` — start the bot honoring the configured TRADING_MODE.
 *
 * PAPER mode runs the full end-to-end paper engine (never touches a real order
 * endpoint).
 *
 * LIVE mode is deliberately hard to enable and fails closed. Three independent
 * conditions must hold, and even then live trading is not yet operational:
 *   1. TRADING_MODE=live
 *   2. REAL_FUNDS_AT_RISK=true        (also enforced by the config schema)
 *   3. An explicit per-invocation confirmation flag:  bot start --confirm-live
 * Afterwards `start` verifies the exchange adapter actually reports
 * `supportsOrderPlacement`. Until the NDAX adapter enables it, live start
 * refuses — there is NO automatic first trade and no startup trade.
 */

import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { createLogger } from '../logging/logger.js';
import type { CommandHandler } from './context.js';
import { runPaperEngine } from './run-engine.js';
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
    return runLiveStart(cfg, args);
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
 * the configuration gates, then verifies the adapter's order-placement
 * capability. Every failure path returns non-zero before any engine runs, so a
 * live order can never be placed by accident or on startup.
 */
function runLiveStart(cfg: BotConfig, args: string[]): number {
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

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  const adapter = createExchange(cfg.exchange, {
    credentials,
    config: {
      enableAuthenticatedReads: cfg.enableAuthenticatedReads,
      baseUrl: cfg.ndaxRestBaseUrl,
    },
  });

  if (!adapter.capabilities.supportsOrderPlacement) {
    // eslint-disable-next-line no-console
    console.error(
      `Cannot start live trading: the ${adapter.id} exchange adapter reports ` +
        'supportsOrderPlacement=false. NDAX order placement is implemented but NOT yet ' +
        'enabled; live trading fails closed and no order can be placed.',
    );
    return 1;
  }

  // Unreachable while every registered adapter keeps supportsOrderPlacement
  // false — kept as an explicit fail-closed sentinel: live start is not wired.
  // eslint-disable-next-line no-console
  console.error(
    'Live start is not yet implemented in this milestone. No automatic first trade will be placed.',
  );
  return 1;
}
