/**
 * buildLiveEngine — the composition root for the AUTONOMOUS LIVE engine.
 *
 * Assembles the exchange adapter, market data, strategy, risk manager, durable
 * live stores, the V1 reconciliation wiring, the armed `LiveOrderEngine`
 * (autonomous session + managed-quote reservation + TOCTOU guard), the read-only
 * `LiveOrderMonitor`, and the `LiveEngine` itself. It also wires the heartbeat
 * (status file) and optional alerting.
 *
 * It refuses to start if the live realm is not recoverable (corrupt/lost state or
 * cross-file contradictions) and reuses the SAME verified helpers as the
 * controlled one-shot live path so there is a single source of truth.
 */

import { Money } from '../money/Money.js';
import { createExchange } from '../exchanges/index.js';
import { LiveMarketData, requiredCandleLookbackMs, defaultCandleMaxAgeMs } from '../marketdata/index.js';
import type { FreshnessPolicy } from '../marketdata/freshness.js';
import { buildStrategy } from '../strategy/index.js';
import { buildRiskManager } from '../risk/index.js';
import { OrderStore } from '../persistence/OrderStore.js';
import { ManagedStateStore } from '../persistence/ManagedStateStore.js';
import { ManualIntentStore } from '../manual/ManualIntentStore.js';
import { ReconcileService } from '../reconcile/ReconcileService.js';
import { LiveOrderEngine } from '../execution/LiveExecutionEngine.js';
import { LiveOrderMonitor } from '../execution/LiveOrderMonitor.js';
import { createAutonomousLiveSession, endAutonomousLiveSession } from '../execution/AutonomousLiveSession.js';
import { buildManagedOrderGuard, buildManagedQuoteReservation } from '../execution/liveHooks.js';
import { writeEngineStatus } from '../monitoring/engineHeartbeat.js';
import { createNotifier } from '../monitoring/notifier.js';
import { appendEquitySample } from '../persistence/equityHistory.js';
import type { Logger } from '../logging/logger.js';
import type { BotConfig } from '../config/schema.js';
import { LiveEngine } from './LiveEngine.js';
import { loadLiveManagedPortfolio, assertLiveRealmRecoverable } from '../cli/live-test-cmd.js';

export interface LiveEngineBundle {
  engine: LiveEngine;
  marketData: LiveMarketData;
  /** The armed session token (revoke on shutdown via `endAutonomousLiveSession`). */
  sessionToken: string;
  stop: () => void;
}

export async function buildLiveEngine(cfg: BotConfig, logger: Logger): Promise<LiveEngineBundle> {
  // Fail closed on unrecoverable/contradictory live state before any engine runs.
  assertLiveRealmRecoverable(cfg);

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  const exchange = createExchange(cfg.exchange, {
    credentials,
    config: {
      enableAuthenticatedReads: cfg.enableAuthenticatedReads,
      baseUrl: cfg.ndaxRestBaseUrl,
    },
  });

  const symbols = cfg.universeMarkets.length ? cfg.universeMarkets : cfg.tradingPairs;
  const evaluateIntervalMs = cfg.evaluateIntervalSeconds * 1000;
  const strategy = buildStrategy(cfg);
  const riskManager = buildRiskManager(cfg);

  // Load/validate the live managed portfolio (never the paper state). Its
  // positions are ALSO polled (beyond the trading universe) so full-portfolio
  // valuation/equity can price every managed asset (F-2/F-8).
  const livePortfolio = loadLiveManagedPortfolio(cfg);
  const positionSymbols = [...livePortfolio.stateModel.positions.keys()];
  const pollSymbols = [...new Set([...symbols, ...positionSymbols])];

  const marketData = new LiveMarketData(exchange, {
    symbols: pollSymbols,
    candleTimeframes: [cfg.timeframe],
    candleIntervalMs: evaluateIntervalMs,
    candleLookbackMs: requiredCandleLookbackMs(cfg.timeframe, strategy.warmupCandles),
  });

  const orders = new OrderStore(cfg.orderLedgerFile);
  const live = new ManagedStateStore(cfg.liveManagedStateFile);
  const manualIntents = new ManualIntentStore(cfg.manualIntentFile);
  const reconcileService = new ReconcileService(exchange, orders);

  // The reservation hook needs a market's fee model. NDAX fees are flat across
  // markets, so the configured first pair's market is used.
  const feeMarket = await exchange.getMarketInfo(cfg.tradingPairs[0]!);
  const reservation = buildManagedQuoteReservation({ live, market: feeMarket });

  // Arm the bounded autonomous session. `supportsOrderPlacement` stays false; the
  // session is the explicit, process-local exception.
  const expiresAtMs =
    cfg.liveAutonomousSessionMinutes > 0
      ? Date.now() + cfg.liveAutonomousSessionMinutes * 60_000
      : Number.MAX_SAFE_INTEGER;
  const session = createAutonomousLiveSession({
    type: 'limit',
    tif: 'IOC',
    sides: ['BUY', 'SELL'],
    maxBaseQuantity: Money.fromNumber(cfg.liveMaxBaseQuantity),
    maxQuoteNotional: Money.fromNumber(cfg.liveMaxQuoteNotional),
    maxSessionQuoteNotional: Money.fromNumber(cfg.liveAutonomousMaxSessionQuoteNotional),
    maxSessionOrders: cfg.liveAutonomousMaxSessionOrders,
    expiresAtMs,
  });

  const liveOrderEngine = new LiveOrderEngine(exchange, orders, reconcileService, riskManager, {
    gate: { tradingMode: 'live', realFundsAtRisk: cfg.realFundsAtRisk },
    killSwitch: cfg.killSwitch,
    maxLiveQuoteNotional: Money.fromNumber(cfg.liveMaxQuoteNotional),
    maxLiveBaseQuantity: Money.fromNumber(cfg.liveMaxBaseQuantity),
    autonomousLiveSession: session,
    managedOrderGuard: buildManagedOrderGuard(live),
    reserveManagedQuote: reservation.reserve,
    releaseManagedQuote: reservation.release,
  });

  const monitor = new LiveOrderMonitor({
    stateDir: cfg.stateDir,
    orders,
    live,
    adapter: exchange,
  });

  const notifier = createNotifier({
    webhookUrl: cfg.alertWebhookUrl,
    ntfyTopic: cfg.alertNtfyTopic,
    ntfyServer: cfg.alertNtfyServer,
    minIntervalMs: cfg.alertMinIntervalMs,
    source: `cryptotradingbot/${cfg.exchange}/live`,
    logger,
  });

  const freshnessPolicy: FreshnessPolicy = {
    maxQuoteAgeMs: cfg.marketDataMaxAgeMs,
    maxTransportAgeMs: cfg.marketDataTransportMaxAgeMs,
    maxAcceptableFutureSkewMs: cfg.maxClockSkewMs,
  };
  const candleMaxAgeMs = cfg.candleMaxAgeMs > 0 ? cfg.candleMaxAgeMs : defaultCandleMaxAgeMs(cfg.timeframe);
  const managedValuationPolicy: FreshnessPolicy | undefined =
    cfg.managedValuationMaxAgeMs > 0
      ? { ...freshnessPolicy, maxQuoteAgeMs: cfg.managedValuationMaxAgeMs }
      : undefined;

  let engineRef: LiveEngine | null = null;
  const engine = new LiveEngine({
    logger,
    marketData,
    exchange,
    strategy,
    riskManager,
    orders,
    live,
    manualIntents,
    stateDir: cfg.stateDir,
    liveOrderEngine,
    monitor,
    evaluateIntervalMs,
    symbols,
    timeframe: cfg.timeframe,
    freshnessPolicy,
    managedValuationPolicy,
    candleMaxAgeMs,
    quoteCurrencies: new Set(cfg.tradingPairs.map((p) => p.split('/')[1] ?? '')),
    killSwitch: cfg.killSwitch,
    onStatus: (status) => {
      try {
        writeEngineStatus(cfg.engineStatusFile, {
          kind: 'live',
          updatedAtMs: Date.now(),
          status: status as unknown as Record<string, unknown>,
        });
        if (status.equity !== null && engineRef) {
          const cash: Record<string, string> = {};
          for (const [cur, amt] of engineRef.currentPortfolio.stateModel.cash) cash[cur] = amt.toString();
          appendEquitySample(cfg.equityHistoryFile, { atMs: Date.now(), equity: status.equity, cash });
        }
      } catch (err) {
        logger.warn({ err }, 'failed to write engine heartbeat/equity sample');
      }
    },
    onEvent: (event) => {
      const level = event.kind === 'CYCLE_ERROR' ? 'error' : 'warn';
      logger[level]({ event: event.kind, detail: event.detail }, 'live engine event');
      notifier.notify({ kind: event.kind, detail: event.detail, atMs: event.atMs });
    },
  });
  engineRef = engine;

  return {
    engine,
    marketData,
    sessionToken: session.token,
    stop: () => endAutonomousLiveSession(session.token),
  };
}
