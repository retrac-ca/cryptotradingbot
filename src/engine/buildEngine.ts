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
import { join } from 'node:path';
import { createExchange } from '../exchanges/index.js';
import { LiveMarketData } from '../marketdata/index.js';
import type { FreshnessPolicy } from '../marketdata/freshness.js';
import { buildStrategy } from '../strategy/index.js';
import { buildRiskManager } from '../risk/index.js';
import { Portfolio } from '../portfolio/index.js';
import { PaperStateStore, StateInitMarker, withStateDirLock, CorruptStateError, migrateLegacyState } from '../persistence/index.js';
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
  // Effective symbol set = the curated universe (falls back to tradingPairs).
  const symbols = cfg.universeMarkets.length ? cfg.universeMarkets : cfg.tradingPairs;
  const marketData = new LiveMarketData(exchange, {
    symbols,
    candleTimeframes: [cfg.timeframe],
    candleIntervalMs: evaluateIntervalMs,
    // ticker default (2s) via omission
  });

  const strategy = buildStrategy(cfg);

  const riskManager = buildRiskManager(cfg);

  const store = new PaperStateStore(cfg.paperStateFile);
  const initMarker = new StateInitMarker(join(cfg.stateDir, '.init.json'));
  // Migrate any legacy top-level state file (once, conservatively) before loading.
  migrateLegacyState(cfg);
  const loaded = loadPortfolio(cfg, store, initMarker);
  const portfolio = loaded.portfolio;

  // F-8: the same freshness policy the RiskManager applies to a candidate quote
  // is applied by the coordinator when valuing NON-candidate managed positions,
  // so a stale managed-position price can never under-state exposure.
  const freshnessPolicy: FreshnessPolicy = {
    maxQuoteAgeMs: cfg.marketDataMaxAgeMs,
    maxTransportAgeMs: cfg.marketDataTransportMaxAgeMs,
    maxAcceptableFutureSkewMs: cfg.maxClockSkewMs,
  };

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
    symbols,
    timeframe: cfg.timeframe,
    freshnessPolicy,
    restoredExecutedOrderIds: loaded.executedOrderIds,
  };
}

/** Load the portfolio from persisted state, or seed fresh on a legitimate first run. */
function loadPortfolio(
  cfg: BotConfig,
  store: PaperStateStore,
  initMarker: StateInitMarker,
): { portfolio: Portfolio; executedOrderIds: string[] } {
  const r = store.load();
  if (r.status === 'CORRUPT') {
    // Defect A: corrupt paper state must HALT, never fresh-seed.
    throw new CorruptStateError(`paper state is corrupt: ${r.reason}`);
  }
  if (r.status === 'OK') {
    const model = store.toPortfolio(r.data);
    if (model) {
      // State exists => the paper realm is definitely initialized.
      if (!initMarker.isInitialized('paper')) {
        withStateDirLock(cfg.stateDir, () => initMarker.markInitialized('paper'));
      }
      return { portfolio: Portfolio.fromModel(model), executedOrderIds: r.data.executedOrderIds };
    }
    throw new CorruptStateError('paper state loaded but could not be reconstructed into a portfolio');
  }

  // MISSING: distinguish first-ever init from unexpected state loss.
  if (initMarker.isInitialized('paper')) {
    throw new CorruptStateError(
      'paper state is missing but the paper realm was already initialized (unexpected state loss); refusing to re-seed',
    );
  }
  // First-ever initialization: seed with the configured starting balance.
  const firstPair = cfg.tradingPairs[0];
  const quote = firstPair ? firstPair.split('/')[1]! : 'CAD';
  const cash = new Map<string, Money>();
  cash.set(quote, Money.fromNumber(cfg.paperStartingBalance));
  const seeded = Portfolio.empty(cash);
  store.save(seeded.stateModel, []);
  withStateDirLock(cfg.stateDir, () => initMarker.markInitialized('paper'));
  return { portfolio: seeded, executedOrderIds: [] };
}
