/**
 * buildEngine — assembles the full PAPER dependency graph from config.
 *
 * This is the composition root for Phase 8. It builds the exchange adapter
 * (read-only market data), the market-data provider, the strategy, the risk
 * manager, the portfolio (from persisted state or a fresh seed), the paper
 * state store, and the paper execution config — then returns ready-to-run
 * `PaperEngineDeps`.
 *
 * Everything here is PAPER-only: the adapter is used solely for read-only
 * market metadata, and the only execution path is `PaperExecutionEngine`.
 */

import { Money } from '../money/Money.js';
import { createExchange } from '../exchanges/index.js';
import { LiveMarketData } from '../marketdata/index.js';
import { buildStrategy } from '../strategy/index.js';
import { buildRiskManager } from '../risk/index.js';
import { Portfolio } from '../portfolio/index.js';
import { PaperStateStore } from '../persistence/index.js';
import type { PaperEngineDeps } from './PaperEngine.js';
import type { Logger } from '../logging/logger.js';
import type { BotConfig } from '../config/schema.js';

export function buildEngineDeps(cfg: BotConfig, logger: Logger): PaperEngineDeps {
  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) {
    credentials.accountId = String(cfg.ndaxAccountId);
  }
  const exchange = createExchange(cfg.exchange, {
    credentials,
    config: {
      enableAuthenticatedReads: cfg.enableAuthenticatedReads,
      baseUrl: cfg.ndaxRestBaseUrl,
    },
  });

  const evaluateIntervalMs = cfg.evaluateIntervalSeconds * 1000;
  const marketData = new LiveMarketData(exchange, {
    symbols: cfg.tradingPairs,
    candleTimeframes: [cfg.timeframe],
    candleIntervalMs: evaluateIntervalMs,
    // ticker default (2s) via omission
  });

  const strategy = buildStrategy(cfg);

  const riskManager = buildRiskManager(cfg);

  const store = new PaperStateStore(cfg.paperStateFile);
  const portfolio = loadPortfolio(cfg, store);

  return {
    logger,
    marketData,
    exchange,
    strategy,
    riskManager,
    portfolio,
    store,
    paperConfig: {
      feeFraction: cfg.paperFeeFraction,
      slippageFraction: cfg.paperSlippageFraction,
      fillFraction: cfg.paperFillFraction,
    },
    evaluateIntervalMs,
    symbols: cfg.tradingPairs,
    timeframe: cfg.timeframe,
  };
}

/** Load the portfolio from persisted state, or seed fresh with starting cash. */
function loadPortfolio(cfg: BotConfig, store: PaperStateStore): Portfolio {
  const saved = store.load();
  const model = saved ? store.toPortfolio(saved) : null;
  if (model) {
    return Portfolio.fromModel(model);
  }
  // Fresh start: seed with the configured starting balance in the first pair's
  // quote currency (configurable, not hard-coded).
  const firstPair = cfg.tradingPairs[0];
  const quote = firstPair ? firstPair.split('/')[1]! : 'CAD';
  const cash = new Map<string, Money>();
  cash.set(quote, Money.fromNumber(cfg.paperStartingBalance));
  return Portfolio.empty(cash);
}
