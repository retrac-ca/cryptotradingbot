/**
 * PaperEngine — the continuously-running end-to-end PAPER trading loop.
 *
 * Wires the existing abstractions together without shortcuts:
 *
 *   Market data → Strategy (Signal) → RiskManager (approve + size)
 *                → PaperExecutionEngine (fill, fees, slippage)
 *                → Portfolio (position / cash / P&L) → Logging / Persistence
 *
 * The loop ticks on a fixed cadence (`evaluateIntervalMs`), not a busy loop.
 * On each tick it evaluates every configured symbol. Market-data failures are
 * handled by the provider (last-good snapshot + `failure` events) and the risk
 * layer fails closed on stale/unknown data. The engine shuts down gracefully,
 * persisting state so a restart does not reset the paper portfolio.
 *
 * SAFETY: this engine only ever drives `PaperExecutionEngine` (local simulated
 * fills). It calls `ExchangeAdapter` for read-only market metadata (market info)
 * but NEVER for order placement; there is no live-execution path here.
 */

import { Money } from '../money/Money.js';
import type { Logger } from '../logging/logger.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { StrategyContext } from '../strategy/StrategyContext.js';
import type { Signal } from '../strategy/Signal.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { RiskContext } from '../risk/RiskContext.js';
import type { RiskDecision } from '../risk/Reason.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { PaperExecutionEngine } from '../execution/PaperExecutionEngine.js';
import type { PaperExecutionConfig } from '../execution/PaperExecutionTypes.js';
import type { PaperStateStore } from '../persistence/PaperStateStore.js';
import type { Timeframe, MarketInfo, Balance } from '../types.js';

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
  private readonly strategy: Strategy;
  private readonly riskManager: RiskManager;
  private portfolio: Portfolio;
  private readonly store: PaperStateStore | null;
  private readonly paper: PaperExecutionEngine;
  private readonly evaluateIntervalMs: number;
  private readonly symbols: string[];
  private readonly timeframe: Timeframe;
  private readonly marketInfoById = new Map<string, MarketInfo>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private marketInfoLoaded = false;
  private startedAtMs: number | null = null;
  private lastEvaluateMs: number | null = null;
  private lastEvaluateError: string | null = null;

  constructor(deps: PaperEngineDeps) {
    this.logger = deps.logger;
    this.marketData = deps.marketData;
    this.exchange = deps.exchange;
    this.strategy = deps.strategy;
    this.riskManager = deps.riskManager;
    this.portfolio = deps.portfolio;
    this.store = deps.store;
    this.paper = new PaperExecutionEngine(deps.paperConfig, deps.portfolio);
    this.evaluateIntervalMs = deps.evaluateIntervalMs;
    this.symbols = deps.symbols;
    this.timeframe = deps.timeframe;
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
      symbols: this.symbols,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = Date.now();
    this.logger.info({ mode: 'PAPER', symbols: this.symbols, timeframe: this.timeframe }, 'paper engine starting');

    await this.refreshMarketInfo();
    this.marketInfoLoaded = true;

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

  /** One evaluation pass over all symbols. Safe to call from a timer or a test. */
  async evaluateOnce(nowMs: number = Date.now()): Promise<void> {
    this.lastEvaluateMs = nowMs;
    try {
      if (!this.marketInfoLoaded) {
        await this.refreshMarketInfo();
        this.marketInfoLoaded = true;
      }
      for (const symbol of this.symbols) {
        await this.evaluateSymbol(symbol, nowMs);
      }
      this.lastEvaluateError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastEvaluateError = message;
      this.logger.error({ err, step: 'evaluateOnce' }, 'evaluation pass failed');
    }
  }

  private async evaluateSymbol(symbol: string, nowMs: number): Promise<void> {
    const position = this.portfolio.position(symbol);
    const candles = this.marketData.getCandles(symbol, this.timeframe);
    const strategyCtx: StrategyContext = {
      nowMs,
      symbol,
      ticker: this.marketData.getTicker(symbol),
      candles,
      timeframe: this.timeframe,
      position: {
        symbol,
        quantity: position?.quantity ?? Money.zero(),
        averageEntryPrice: position?.averageEntryPrice ?? null,
        realizedPnl: position?.realizedPnl ?? Money.zero(),
      },
      insufficientData: candles.length < this.strategy.warmupCandles,
    };

    const signal = this.strategy.evaluate(strategyCtx);
    this.logger.info(
      { symbol, signalType: signal.type, reason: signal.reason, candles: candles.length },
      'strategy signal',
    );
    if (signal.type === 'HOLD') return;

    const riskCtx = this.buildRiskContext(symbol, signal, nowMs);
    const decision = this.riskManager.evaluate(riskCtx);
    this.logDecision(symbol, decision);
    if (!decision.approved) return;

    const ticker = this.marketData.getTicker(symbol);
    const buy = signal.type === 'BUY';
    const referencePrice = buy
      ? ticker?.ask ?? ticker?.last
      : ticker?.bid ?? ticker?.last;
    if (!referencePrice || !referencePrice.isPositive()) {
      this.logger.warn({ symbol }, 'cannot price approved order; skipping');
      return;
    }

    const orderRequest = {
      clientOrderId: `paper-${symbol.replace('/', '')}-${nowMs}`,
      symbol,
      side: decision.side,
      type: 'market' as const,
      quantity: decision.quantity,
      reason: decision.reason,
    };
    const fill = this.paper.submitMarketOrder(
      orderRequest,
      {
        referencePrice,
        bid: ticker?.bid ?? referencePrice,
        ask: ticker?.ask ?? referencePrice,
      },
      nowMs,
    );
    this.portfolio = this.paper.currentPortfolio;
    this.logger.info(
      {
        symbol,
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

  private buildRiskContext(symbol: string, signal: Signal, nowMs: number): RiskContext {
    const ticker = this.marketData.getTicker(symbol);
    const quote = symbol.split('/')[1]!;
    const prices = this.prices();
    const mtm = this.portfolio.markToMarket(prices);
    const position = this.portfolio.position(symbol);
    const quoteBalance: Balance = {
      currency: quote,
      total: this.portfolio.cash(quote),
      available: this.portfolio.cash(quote),
      held: Money.zero(),
    };
    const refPrice = ticker?.ask ?? ticker?.last ?? ticker?.bid ?? null;
    return {
      symbol,
      signal,
      nowMs,
      marketDataTimestampMs: ticker?.timestampMs ?? null,
      price: refPrice,
      marketInfo: this.marketInfoById.get(symbol) ?? null,
      quoteBalance,
      portfolioValue: mtm.equity,
      peakPortfolioValue: this.portfolio.stateModel.peakEquity,
      portfolioExposure: this.portfolio.exposure(prices),
      currentPosition: position?.quantity ?? Money.zero(),
      realizedPnlToday: this.portfolio.stateModel.realizedPnl,
      unrealizedPnlToday: mtm.unrealizedPnl,
    };
  }

  private prices(): Map<string, Money> {
    const map = new Map<string, Money>();
    for (const symbol of this.symbols) {
      const t = this.marketData.getTicker(symbol);
      const price = t?.last ?? t?.ask ?? t?.bid;
      if (price) map.set(symbol, price);
    }
    return map;
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

  private logDecision(symbol: string, decision: RiskDecision): void {
    if (decision.approved) {
      this.logger.info(
        { symbol, approved: true, quantity: decision.quantity.toString(), notional: decision.estimatedNotional.toString() },
        'risk approved',
      );
    } else {
      this.logger.info(
        { symbol, approved: false, reason: decision.reason, detail: decision.detail },
        'risk rejected',
      );
    }
  }

  private portfolioSummary(): Record<string, unknown> {
    const cash: Record<string, string> = {};
    for (const [cur, amt] of this.portfolio.stateModel.cash) cash[cur] = amt.toString();
    const positions: Record<string, unknown> = {};
    for (const [sym, p] of this.portfolio.stateModel.positions) {
      positions[sym] = { quantity: p.quantity.toString(), averageEntryPrice: p.averageEntryPrice.toString() };
    }
    return { cash, positions, realizedPnl: this.portfolio.stateModel.realizedPnl.toString() };
  }

  private persist(): void {
    if (this.store) {
      const ids = this.paper.orderHistory.map((o) => o.clientOrderId);
      this.store.save(this.portfolio.stateModel, ids);
    }
  }
}
