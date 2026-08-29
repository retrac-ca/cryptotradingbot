/**
 * runPaperEngine — run the continuously-running PAPER engine with graceful
 * shutdown, wiring market data + engine and handling SIGINT/SIGTERM.
 *
 * Returns the process exit code (0 for a clean stop).
 */

import type { BotConfig } from '../config/schema.js';
import type { Logger } from '../logging/logger.js';
import { buildEngineDeps } from '../engine/buildEngine.js';
import { PaperEngine } from '../engine/PaperEngine.js';
import { LiveMarketData } from '../marketdata/LiveMarketData.js';

export async function runPaperEngine(cfg: BotConfig, logger: Logger): Promise<number> {
  const deps = buildEngineDeps(cfg, logger);
  const marketData = deps.marketData as LiveMarketData;
  const engine = new PaperEngine(deps);

  logger.info({ symbols: cfg.tradingPairs }, 'starting market data polling');
  await marketData.start();

  await engine.start();

  logger.info(
    { hint: 'press Ctrl-C to stop', mode: 'PAPER' },
    'paper bot running; waiting for shutdown signal',
  );

  await new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal: sig }, 'received shutdown signal, stopping gracefully');
      engine.stop();
      marketData.stop();
      resolve(0);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  });

  return 0;
}
