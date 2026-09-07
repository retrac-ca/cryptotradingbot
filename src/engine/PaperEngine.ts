/**
 * PaperEngine — the continuously-running end-to-end PAPER trading loop.
 *
 * Wires the existing abstractions together without shortcuts:
 *
 *   Market data → Multi-asset universe/eligibility → Coordinator
 *                → Strategy (Signal) → RiskManager (approve + size)
 *                → select ONE approved opportunity per cycle
 *                → PaperExecutionEngine (fill, fees, slippage)
 *                → Managed Portfolio (position / cash / P&L / ownership)
 *                → Logging / Persistence
 *
 * The loop ticks on a fixed cadence (`evaluateIntervalMs`), not a busy loop.
 * Each cycle the coordinator evaluates every ELIGIBLE market in the universe,
 * collects risk-approved opportunities, deterministically ranks them, and
 * executes at most ONE trade. Market-data failures are handled by the provider
 * (last-good snapshot + `failure` events) and the risk layer fails closed on
 * stale/unknown data. The engine shuts down gracefully, persisting state so a
 * restart does not reset the paper managed portfolio.
 *
 * OWNERSHIP: the engine's `Portfolio` is the bot-MANAGED portfolio. External
 * holdings are recorded in `externalSnapshot` and are never auto-sold and never
 * count as bot position/exposure. The strategy and RiskManager both see only the
 * managed quantity, so an account holding pre-existing BTC never has that BTC
 * traded by the bot.
 *
 * SAFETY: this engine only ever drives `PaperExecutionEngine` (local simulated
 * fills). It calls `ExchangeAdapter` for read-only market metadata (market info)
 * but NEVER for order placement; there is no live-execution path here.
 */

import { Money } from '../money/Money.js';
import type { Logger } from '../logging/logger.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import type { FreshnessPolicy } from '../marketdata/freshness.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { RiskManager } from '../risk/RiskManager.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { PaperExecutionEngine } from '../execution/PaperExecutionEngine.js';
import type { PaperExecutionConfig } from '../execution/PaperExecutionTypes.js';
import type { PaperStateStore } from '../persistence/PaperStateStore.js';
import type { Timeframe, MarketInfo } from '../types.js';
import { MarketCoordinator } from './MarketCoordinator.js';
import { eligibleSymbols } from './universe.js';

export interface PaperEngineDeps {
  logger: Logger;
  marketData: MarketDataProvider;
  exchange: ExchangeAdapter;
  strategy: Strategy;
  riskManager: RiskManager;
  portfolio: Portfolio;
  store: PaperStateStore | null;
  paperConfig: PaperExecutionConfig;
  evaluateIntervalMs: number;
  symbols: string[];
  timeframe: Timeframe;
  /** F-8: freshness policy applied to managed-position valuation quotes. */
  freshnessPolicy: FreshnessPolicy;
  /**
   * Durable executed-order identity loaded from persisted state on restart, so
   * the paper engine's order identity is consistent with the durable
   * `executedOrderIds` and is not dropped by the next save.
   */
  restoredExecutedOrderIds?: string[];
}

export interface PaperEngineStatus {
  running: boolean;
  startedAtMs: number | null;
  lastEvaluateMs: number | null;
  lastEvaluateError: string | null;
  symbols: string[];
}

export class PaperEngine {
  private readonly logger: Logger;
  private readonly marketData: MarketDataProvider;
  private readonly exchange: ExchangeAdapter;
  private portfolio: Portfolio;
  private readonly store: PaperStateStore | null;
  private readonly paper: PaperExecutionEngine;
  private readonly evaluateIntervalMs: number;
  private readonly symbols: string[];
  private readonly timeframe: Timeframe;
  private readonly marketInfoById = new Map<string, MarketInfo>();
  private readonly coordinator: MarketCoordinator;
  private readonly quote: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private marketInfoLoaded = false;
  private eligibleSymbols: string[] = [];
  private startedAtMs: number | null = null;
  private lastEvaluateMs: number | null = null;
  private lastEvaluateError: string | null = null;

  constructor(deps: PaperEngineDeps) {
    this.logger = deps.logger;
    this.marketData = deps.marketData;
    this.exchange = deps.exchange;
    this.portfolio = deps.portfolio;
    this.store = deps.store;
    this.paper = new PaperExecutionEngine(deps.paperConfig, deps.portfolio);
    this.paper.restoreExecutedOrderIds(deps.restoredExecutedOrderIds ?? []);
    this.evaluateIntervalMs = deps.evaluateIntervalMs;
    this.symbols = deps.symbols;
    this.timeframe = deps.timeframe;
    this.quote = deps.symbols[0]?.split('/')[1] || 'quote';
    this.coordinator = new MarketCoordinator({
      strategy: deps.strategy,
      riskManager: deps.riskManager,
      getPortfolio: () => this.portfolio,
      timeframe: deps.timeframe,
      marketSource: {
        getMarketInfo: (symbol) => this.marketInfoById.get(symbol) ?? null,
        getTicker: (symbol) => this.marketData.getTicker(symbol),
        getCandles: (symbol, tf) => this.marketData.getCandles(symbol, tf),
      },
      freshnessPolicy: deps.freshnessPolicy,
    });
  }

  get currentPortfolio(): Portfolio {
    return this.portfolio;
  }

  get orderHistory() {
    return this.paper.orderHistory;
  }

  get status(): PaperEngineStatus {
    return {
      running: this.running,
      startedAtMs: this.startedAtMs,
      lastEvaluateMs: this.lastEvaluateMs,
      lastEvaluateError: this.lastEvaluateError,
      symbols: this.eligibleSymbols.length ? this.eligibleSymbols : this.symbols,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = Date.now();
    this.logger.info(
      { mode: 'PAPER', universe: this.symbols, timeframe: this.timeframe },
      'paper engine starting',
    );

    await this.refreshMarketInfo();
    this.marketInfoLoaded = true;
    this.refreshEligibleUniverse();

    this.timer = setInterval(() => {
      void this.evaluateOnce();
    }, this.evaluateIntervalMs);
    if (this.timer.unref) this.timer.unref();

    this.logger.info(
      { evaluateIntervalMs: this.evaluateIntervalMs, portfolio: this.portfolioSummary() },
      'paper engine started',
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.persist();
    this.logger.info({ portfolio: this.portfolioSummary() }, 'paper engine stopped and state persisted');
  }

  /** One evaluation pass over the eligible universe. Safe to call from a timer or a test. */
  async evaluateOnce(nowMs: number = Date.now()): Promise<void> {
    this.lastEvaluateMs = nowMs;
    try {
      if (!this.marketInfoLoaded) {
        await this.refreshMarketInfo();
        this.marketInfoLoaded = true;
        this.refreshEligibleUniverse();
      }
      const result = this.coordinator.evaluate(this.eligibleSymbols.length ? this.eligibleSymbols : this.symbols, nowMs);

      for (const m of result.evaluated) {
        this.logger.info(
          {
            symbol: m.symbol,
            signal: m.signalType,
            reason: m.signalReason,
            skipped: m.skipped,
            skipReason: m.skipReason,
            approved: m.decision?.approved ?? false,
            riskReason: m.decision?.approved ? null : m.decision?.reason,
          },
          'market evaluated',
        );
      }

      if (result.selected) {
        this.executeSelected(result.selected, nowMs);
      } else {
        this.logger.info({ cycle: nowMs }, 'coordinator: NO TRADE this cycle');
      }

      this.lastEvaluateError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastEvaluateError = message;
      this.logger.error({ err, step: 'evaluateOnce' }, 'evaluation pass failed');
    }
  }

  private executeSelected(
    selected: { symbol: string; side: 'BUY' | 'SELL'; quantity: Money; referencePrice: Money },
    nowMs: number,
  ): void {
    const ticker = this.marketData.getTicker(selected.symbol);
    this.logger.info(
      { symbol: selected.symbol, side: selected.side, quantity: selected.quantity.toString() },
      'coordinator: executing approved trade',
    );

    const orderRequest = {
      clientOrderId: `paper-${selected.symbol.replace('/', '')}-${nowMs}`,
      symbol: selected.symbol,
      side: selected.side,
      type: 'market' as const,
      quantity: selected.quantity,
      reason: 'coordinator-approved',
    };
    const fill = this.paper.submitMarketOrder(
      orderRequest,
      {
        referencePrice: selected.referencePrice,
        bid: ticker?.bid ?? selected.referencePrice,
        ask: ticker?.ask ?? selected.referencePrice,
      },
      nowMs,
    );
    this.portfolio = this.paper.currentPortfolio;
    this.logger.info(
      {
        symbol: selected.symbol,
        side: fill.side,
        status: fill.status,
        quantity: fill.filledQuantity.toString(),
        averagePrice: fill.averagePrice?.toString(),
        fee: fill.fee.toString(),
        clientOrderId: fill.clientOrderId,
      },
      'paper fill',
    );
    this.persist();
  }

  /** Recompute the eligible universe from the configured/approved symbols + discovered markets. */
  private refreshEligibleUniverse(): void {
    const markets = [...this.symbols]
      .map((s) => this.marketInfoById.get(s))
      .filter((m): m is MarketInfo => m != null);
    this.eligibleSymbols = eligibleSymbols(markets, { quote: this.quote, approvedSymbols: this.symbols });
    this.logger.info(
      { universe: this.symbols, eligible: this.eligibleSymbols },
      'eligibility: filtered universe',
    );
  }

  private async refreshMarketInfo(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        const info = await this.exchange.getMarketInfo(symbol);
        this.marketInfoById.set(symbol, info);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn({ symbol, message }, 'failed to load market info; risk will fail closed for this symbol');
      }
    }
  }

  private portfolioSummary(): Record<string, unknown> {
    const cash: Record<string, string> = {};
    for (const [cur, amt] of this.portfolio.stateModel.cash) cash[cur] = amt.toString();
    const positions: Record<string, unknown> = {};
    for (const [sym, p] of this.portfolio.stateModel.positions) {
      positions[sym] = {
        quantity: p.quantity.toString(),
        averageEntryPrice: p.averageEntryPrice.toString(),
        source: p.source,
        sourceBreakdown: {
          BOT: (p.sourceQuantities?.BOT ?? Money.zero()).toString(),
          EXTERNAL_AUTHORIZED: (p.sourceQuantities?.EXTERNAL_AUTHORIZED ?? Money.zero()).toString(),
        },
      };
    }
    return { cash, positions, realizedPnl: this.portfolio.stateModel.realizedPnl.toString() };
  }

  private persist(): void {
    if (this.store) {
      const ids = this.paper.executedOrderIds;
      this.store.save(this.portfolio.stateModel, ids);
    }
  }
}
