/**
 * runLiveEngine — run the continuously-running AUTONOMOUS LIVE engine with
 * graceful shutdown, wiring market data + engine and handling SIGINT/SIGTERM.
 *
 * Only reached from the armed `bot start` live path (config + REAL_FUNDS_AT_RISK
 * + `--confirm-live`). Returns the process exit code (0 for a clean stop).
 */

import type { BotConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { buildLiveEngine } from '../engine/buildLiveEngine.js';

export async function runLiveEngine(cfg: BotConfig, logger: Logger): Promise<number> {
  const bundle = await buildLiveEngine(cfg, logger);

  logger.warn(
    { universe: cfg.universeMarkets.length ? cfg.universeMarkets : cfg.tradingPairs, mode: 'LIVE' },
    'starting AUTONOMOUS LIVE engine',
  );
  await bundle.marketData.start();
  await bundle.engine.start();

  await new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) return;
      stopping = true;
      logger.warn({ signal: sig }, 'received shutdown signal; stopping autonomous live engine');
      bundle.engine.stop();
      bundle.marketData.stop();
      bundle.stop();
      resolve(0);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  });

  return 0;
}
