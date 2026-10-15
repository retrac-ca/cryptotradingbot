/**
 * LiveEngine — the continuously-running, AUTONOMOUS live trading loop.
 *
 * This is the live counterpart of `PaperEngine`: it wires the same
 * Strategy -> RiskManager -> Multi-asset Coordinator selection to the REAL
 * exchange through `LiveOrderEngine`, and continuously reconciles/accounts the
 * result. It is only constructed by the armed `bot start` live path, which
 * mints a bounded `AutonomousLiveSession` and a `LiveOrderEngine` configured
 * with a session budget, a managed-quote reservation hook, and a TOCTOU
 * managed-state guard.
 *
 * Safety posture (all fail-closed):
 *   - LIMIT + IOC only (never rests on the book), so at most one order is ever
 *     in flight and no auto-cancel path is needed.
 *   - Before placing, it requires the action-aware reconciliation gate to allow
 *     the exact intended action; unresolved live orders block new entries.
 *   - Every cycle it runs the read-only `LiveOrderMonitor` and `reconcile()` +
 *     `commitProven()` to advance order state, apply PROVEN fills idempotently,
 *     and release only safe reservations.
 *   - Circuit breakers HALT new placement (while continuing to observe) on:
 *     reconciliation HALTED, any exchange read failure, an UNKNOWN order, the
 *     kill switch, or repeated cycle errors.
 *   - A stale candle series or stale quote fails closed in the decision path.
 *
 * The engine NEVER constructs a raw order: `LiveOrderEngine.place` re-runs the
 * RiskManager against the coordinator's exact `RiskContext` and builds the order
 * solely from that approval. The engine holds no bypass.
 */

import type { Logger } from '../logging/logger.js';
import type { MarketDataProvider } from '../marketdata/types.js';
import type { FreshnessPolicy } from '../marketdata/freshness.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { RiskManager } from '../risk/RiskManager.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { Money } from '../money/Money.js';
import type { ManagedStateStore } from '../persistence/ManagedStateStore.js';
import type { OrderStore } from '../persistence/OrderStore.js';
import type { ManualIntentStore } from '../manual/ManualIntentStore.js';
import { LiveOrderEngine, LiveGateError } from '../execution/LiveExecutionEngine.js';
import type { LiveOrderResult } from '../execution/LiveExecutionEngine.js';
import type { LiveOrderMonitor } from '../execution/LiveOrderMonitor.js';
import type { OrderStatus } from '../order.js';
import { reconcile, commitProven } from '../reconcile/orchestrator.js';
import type { ReconciliationDeps, ReconciliationResult } from '../reconcile/index.js';
import { livePreTradeGate } from '../reconcile/preTradeGate.js';
import { MarketCoordinator } from './MarketCoordinator.js';
import type { SelectedTrade } from './MarketCoordinator.js';
import { eligibleSymbols } from './universe.js';
import type { MarketInfo, Timeframe } from '../types.js';

const UNRESOLVED_LIVE: ReadonlySet<OrderStatus> = new Set([
  'CREATED',
  'SUBMITTED',
  'OPEN',
  'PARTIALLY_FILLED',
  'UNKNOWN',
]);

export interface LiveEngineHalt {
  reason: string;
  atMs: number;
}

export interface LiveEngineStatus {
  running: boolean;
  halted: boolean;
  halt: LiveEngineHalt | null;
  startedAtMs: number | null;
  lastEvaluateMs: number | null;
  lastEvaluateError: string | null;
  lastReconciliationStatus: string | null;
  consecutiveErrors: number;
  ordersPlaced: number;
  /** Best-effort managed equity (quote), or null when any position is unpriceable. */
  equity: string | null;
  symbols: string[];
  eligible: string[];
}

/** A critical event surfaced for alerting (never contains secrets). */
export interface LiveEngineEvent {
  kind: 'HALTED' | 'UNKNOWN_ORDER' | 'ORDER_REJECTED' | 'CYCLE_ERROR' | 'STARTED' | 'STOPPED';
  detail: string;
  atMs: number;
}

export interface LiveEngineDeps {
  logger: Logger;
  marketData: MarketDataProvider;
  exchange: ExchangeAdapter;
  strategy: Strategy;
  riskManager: RiskManager;
  orders: OrderStore;
  live: ManagedStateStore;
  manualIntents: ManualIntentStore;
  /** The shared state directory (mutation lock + all state domains). */
  stateDir: string;
  /** The armed live order engine (session + reservation + TOCTOU guard wired). */
  liveOrderEngine: LiveOrderEngine;
  /** Read-only lifecycle observer/accounting for unresolved live orders. */
  monitor: LiveOrderMonitor;
  evaluateIntervalMs: number;
  symbols: string[];
  timeframe: Timeframe;
  freshnessPolicy: FreshnessPolicy;
  /** F-8: optional looser policy for NON-candidate managed-position valuation. */
  managedValuationPolicy?: FreshnessPolicy;
  candleMaxAgeMs?: number;
  /** Quote currencies for the configured pairs (for the action-aware gate). */
  quoteCurrencies: ReadonlySet<string>;
  /** Global/remote kill switch (static config). A dynamic arm may also be checked. */
  killSwitch: boolean;
  /** Halt after this many consecutive cycle errors. Default 5. */
  maxConsecutiveErrors?: number;
  nowMs?: () => number;
  /** Critical-event sink (alerting / audit). */
  onEvent?: (event: LiveEngineEvent) => void;
  /** Status sink (heartbeat), invoked after every cycle. */
  onStatus?: (status: LiveEngineStatus) => void;
}

export class LiveEngine {
  private readonly deps: LiveEngineDeps;
  private readonly now: () => number;
  private readonly coordinator: MarketCoordinator;
  private readonly quote: string;

  private portfolio: Portfolio;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private halted = false;
  private halt: LiveEngineHalt | null = null;
  private startedAtMs: number | null = null;
  private lastEvaluateMs: number | null = null;
  private lastEvaluateError: string | null = null;
  private lastReconciliationStatus: string | null = null;
  private consecutiveErrors = 0;
  private ordersPlaced = 0;
  private marketInfoLoaded = false;
  private marketInfoById = new Map<string, MarketInfo>();
  private eligible: string[] = [];

  constructor(deps: LiveEngineDeps) {
    this.deps = deps;
    this.now = deps.nowMs ?? (() => Date.now());
    this.portfolio = this.loadPortfolioOrThrow();
    this.quote = deps.symbols[0]?.split('/')[1] || 'CAD';
    this.coordinator = new MarketCoordinator({
      strategy: deps.strategy,
      riskManager: deps.riskManager,
      getPortfolio: () => this.portfolio,
      timeframe: deps.timeframe,
      marketSource: {
        getMarketInfo: (symbol) => this.marketInfoById.get(symbol) ?? null,
        getTicker: (symbol) => deps.marketData.getTicker(symbol),
        getCandles: (symbol, tf) => deps.marketData.getCandles(symbol, tf),
      },
      freshnessPolicy: deps.freshnessPolicy,
      managedValuationPolicy: deps.managedValuationPolicy,
      candleMaxAgeMs: deps.candleMaxAgeMs,
    });
  }

  get status(): LiveEngineStatus {
    return {
      running: this.running,
      halted: this.halted,
      halt: this.halt,
      startedAtMs: this.startedAtMs,
      lastEvaluateMs: this.lastEvaluateMs,
      lastEvaluateError: this.lastEvaluateError,
      lastReconciliationStatus: this.lastReconciliationStatus,
      consecutiveErrors: this.consecutiveErrors,
      ordersPlaced: this.ordersPlaced,
      equity: this.computeEquity(),
      symbols: this.deps.symbols,
      eligible: this.eligible.length ? this.eligible : this.deps.symbols,
    };
  }

  /**
   * Best-effort managed equity (quote) from the latest polled tickers. Returns
   * null when any managed position cannot be priced (so a consumer never reads a
   * misleading partial equity). Never invents a price.
   */
  private computeEquity(): string | null {
    const priceMap = new Map<string, Money>();
    for (const pos of this.portfolio.stateModel.positions.values()) {
      const t = this.deps.marketData.getTicker(pos.symbol);
      const mark = t?.last ?? t?.ask ?? t?.bid ?? null;
      if (!mark) return null;
      priceMap.set(pos.symbol, mark);
    }
    return this.portfolio.markToMarket(priceMap).equity.toString();
  }

  get currentPortfolio(): Portfolio {
    return this.portfolio;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.deps.killSwitch) {
      this.haltNow('KILL_SWITCH is enabled at startup');
      return;
    }
    this.running = true;
    this.startedAtMs = this.now();
    this.deps.logger.warn(
      { mode: 'LIVE', universe: this.deps.symbols, timeframe: this.deps.timeframe },
      'AUTONOMOUS LIVE engine starting',
    );
    this.emit({ kind: 'STARTED', detail: 'autonomous live engine started', atMs: this.now() });

    await this.refreshMarketInfo();
    this.marketInfoLoaded = true;
    this.refreshEligibleUniverse();

    // Run one reconciliation/accounting cycle immediately so startup state is
    // observed before any order, then start the timer.
    await this.evaluateOnce(this.now());

    this.timer = setInterval(() => {
      void this.evaluateOnce(this.now());
    }, this.deps.evaluateIntervalMs);
    if (this.timer.unref) this.timer.unref();

    this.publishStatus();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit({ kind: 'STOPPED', detail: 'autonomous live engine stopped', atMs: this.now() });
    this.deps.logger.warn({ portfolio: this.summary() }, 'autonomous live engine stopped');
    this.publishStatus();
  }

  /** Halt new placement (monitoring/accounting is retained). */
  haltNow(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.halt = { reason, atMs: this.now() };
    this.deps.riskManager.setKillSwitch(true);
    this.deps.logger.error({ reason }, 'AUTONOMOUS LIVE engine HALTED (no further orders)');
    this.emit({ kind: 'HALTED', detail: reason, atMs: this.now() });
    this.publishStatus();
  }

  /** One full cycle. Safe to call directly from a test. */
  async evaluateOnce(nowMs: number): Promise<void> {
    this.lastEvaluateMs = nowMs;
    try {
      if (!this.marketInfoLoaded) {
        await this.refreshMarketInfo();
        this.marketInfoLoaded = true;
        this.refreshEligibleUniverse();
      }

      // Kill switch is sticky: once active, no new orders. Re-check each cycle so
      // a config/flag change or an earlier halt is respected. We still fall
      // through to account/observe below; only NEW placement is blocked.
      if (this.deps.killSwitch || this.deps.riskManager.getKillSwitchActive()) {
        if (!this.halted) this.haltNow('kill switch active');
      }

      // 1) Account for prior/unresolved orders (monitor + reconcile + commit).
      //    This runs even when halted so the engine keeps observing/accounting.
      const rec = await this.reconcileAndAccount();
      if (this.halted) return;

      // 2) Never place while an unresolved live order exists.
      const unresolved = this.unresolvedLiveOrders();
      if (unresolved.length > 0) {
        this.deps.logger.info(
          { unresolved },
          'live order unresolved; waiting (no new entry this cycle)',
        );
        this.lastEvaluateError = null;
        this.consecutiveErrors = 0;
        this.publishStatus();
        return;
      }

      // 3) Evaluate the eligible universe and select at most one trade.
      const result = this.coordinator.evaluate(
        this.eligible.length ? this.eligible : this.deps.symbols,
        nowMs,
      );
      for (const m of result.evaluated) {
        this.deps.logger.info(
          {
            symbol: m.symbol,
            signal: m.signalType,
            reason: m.signalReason,
            skipped: m.skipped,
            skipReason: m.skipReason,
            approved: m.decision?.approved ?? false,
            riskReason: m.decision?.approved ? null : m.decision?.reason,
          },
          'market evaluated (LIVE)',
        );
      }

      if (!result.selected) {
        this.deps.logger.info({ cycle: nowMs }, 'coordinator: NO TRADE this cycle (LIVE)');
        this.consecutiveErrors = 0;
        this.lastEvaluateError = null;
        this.publishStatus();
        return;
      }

      await this.executeSelected(result.selected, rec, nowMs);
      this.consecutiveErrors = 0;
      this.lastEvaluateError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastEvaluateError = message;
      this.consecutiveErrors += 1;
      this.deps.logger.error({ err, step: 'liveEvaluateOnce' }, 'live evaluation pass failed');
      this.emit({ kind: 'CYCLE_ERROR', detail: message, atMs: nowMs });
      const max = this.deps.maxConsecutiveErrors ?? 5;
      if (this.consecutiveErrors >= max) {
        this.haltNow(`${this.consecutiveErrors} consecutive cycle errors (last: ${message})`);
      }
    }
    this.publishStatus();
  }

  // ---- internals ----

  private async executeSelected(
    selected: SelectedTrade,
    rec: ReconciliationResult,
    nowMs: number,
  ): Promise<void> {
    const gate = livePreTradeGate(rec, {
      side: selected.side,
      symbol: selected.symbol,
      quoteCurrencies: this.deps.quoteCurrencies,
      managedQuoteDeployable: this.portfolio.deployableQuote(selected.symbol.split('/')[1] ?? this.quote),
    });
    if (!gate.allowed) {
      this.deps.logger.warn(
        { symbol: selected.symbol, side: selected.side, blockers: gate.blockers },
        'live entry blocked by action-aware pre-trade gate',
      );
      return;
    }

    const intent = {
      reason: `autonomous ${selected.side} (coordinator)`,
      type: 'limit' as const,
      price: selected.referencePrice,
      tif: 'IOC' as const,
    };

    let result: LiveOrderResult;
    try {
      // The EXACT risk context the coordinator approved; the engine re-runs risk
      // against it and builds the order solely from that approval.
      result = await this.deps.liveOrderEngine.place(selected.riskContext, intent);
    } catch (err) {
      if (err instanceof LiveGateError) {
        this.deps.logger.warn({ err: err.message }, 'live placement refused by gate');
        return;
      }
      throw err;
    }

    if (result.order.status === 'REJECTED') {
      this.deps.logger.warn(
        { symbol: selected.symbol, side: selected.side, message: result.message },
        'live order rejected (no retry)',
      );
      this.emit({ kind: 'ORDER_REJECTED', detail: result.message, atMs: nowMs });
      return;
    }

    this.ordersPlaced += 1;
    this.deps.logger.warn(
      {
        symbol: selected.symbol,
        side: selected.side,
        clientOrderId: result.order.clientOrderId,
        exchangeOrderId: result.order.exchangeOrderId,
        status: result.order.status,
      },
      'LIVE order submitted',
    );

    if (result.unknownOutcome || result.order.status === 'UNKNOWN') {
      // Ambiguous submission: NEVER retry. Halt new placement until an operator
      // (or the monitor) resolves it.
      this.emit({
        kind: 'UNKNOWN_ORDER',
        detail: `${result.order.clientOrderId}: ${result.message}`,
        atMs: nowMs,
      });
      this.haltNow(`ambiguous LIVE submission ${result.order.clientOrderId}; reconcile before continuing`);
      return;
    }

    // Account immediately (a fast IOC fill may already be terminal).
    await this.reconcileAndAccount();
  }

  /**
   * Read-only monitor + authoritative reconcile, then idempotently apply PROVEN
   * fills and release only safe reservations. Halts on HALTED/read failures.
   */
  private async reconcileAndAccount(): Promise<ReconciliationResult> {
    try {
      await this.deps.monitor.monitorOnce();
    } catch (err) {
      this.deps.logger.warn({ err }, 'live order monitor cycle failed (will retry next cycle)');
    }

    const deps: ReconciliationDeps = {
      stateDir: this.deps.stateDir,
      orders: this.deps.orders,
      live: this.deps.live,
      manualIntents: this.deps.manualIntents,
      adapter: this.deps.exchange,
      nowMs: this.now,
    };
    const rec = await reconcile(deps);
    // Apply only deterministic PROVEN accounting + safe reservation releases.
    const committed = commitProven(deps, rec);
    this.lastReconciliationStatus = committed.status;
    this.reloadPortfolio();

    if (rec.status === 'HALTED') {
      this.haltNow(`reconciliation HALTED: ${rec.reasons.join('; ') || 'unknown'}`);
    } else if (rec.readFailures.length > 0) {
      this.haltNow(`reconciliation read failure: ${rec.readFailures.join('; ')}`);
    }
    return committed;
  }

  private unresolvedLiveOrders(): string[] {
    const out: string[] = [];
    for (const o of this.deps.orders.allOrders().values()) {
      if (o.clientOrderId.startsWith('live-') && UNRESOLVED_LIVE.has(o.status)) {
        out.push(`${o.clientOrderId}:${o.status}`);
      }
    }
    return out;
  }

  private loadPortfolioOrThrow(): Portfolio {
    const r = this.deps.live.load();
    if (r.status === 'CORRUPT') {
      throw new Error(`live managed state is corrupt: ${r.reason}`);
    }
    const p = r.status === 'OK' ? this.deps.live.toPortfolio(r.data) : null;
    return p ?? Portfolio.empty(new Map());
  }

  private reloadPortfolio(): void {
    const r = this.deps.live.load();
    if (r.status === 'CORRUPT') {
      this.haltNow(`live managed state is corrupt: ${r.reason}`);
      return;
    }
    const p = r.status === 'OK' ? this.deps.live.toPortfolio(r.data) : null;
    if (p) this.portfolio = p;
  }

  private async refreshMarketInfo(): Promise<void> {
    for (const symbol of this.deps.symbols) {
      try {
        const info = await this.deps.exchange.getMarketInfo(symbol);
        this.marketInfoById.set(symbol, info);
      } catch (err) {
        this.deps.logger.warn(
          { symbol, message: err instanceof Error ? err.message : String(err) },
          'failed to load market info (risk will fail closed for this symbol)',
        );
      }
    }
  }

  private refreshEligibleUniverse(): void {
    const markets = [...this.deps.symbols]
      .map((s) => this.marketInfoById.get(s))
      .filter((m): m is MarketInfo => m != null);
    this.eligible = eligibleSymbols(markets, { quote: this.quote, approvedSymbols: this.deps.symbols });
    this.deps.logger.info(
      { universe: this.deps.symbols, eligible: this.eligible },
      'eligibility: filtered LIVE universe',
    );
  }

  private summary(): Record<string, unknown> {
    const cash: Record<string, string> = {};
    for (const [cur, amt] of this.portfolio.stateModel.cash) cash[cur] = amt.toString();
    return { cash, realizedPnl: this.portfolio.stateModel.realizedPnl.toString() };
  }

  private emit(event: LiveEngineEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // Alerting must never break the engine.
    }
  }

  private publishStatus(): void {
    try {
      this.deps.onStatus?.(this.status);
    } catch {
      // Heartbeat must never break the engine.
    }
  }
}
