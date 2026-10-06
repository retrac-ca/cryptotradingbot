/**
 * Dashboard application shell.
 *
 * Wires the read-only {@link ApiClient} to the pure render functions and the
 * {@link Poller}. Only inexpensive snapshot endpoints are polled; reconciliation
 * is triggered solely by the explicit user control.
 *
 * Every section renders independently: a failure in one endpoint leaves the
 * others intact and never blanks the dashboard.
 */

import { ApiClient, type ApiResult } from './client.js';
import { Poller } from './poller.js';
import { ReconcileController } from './reconcileController.js';
import { badge, healthTone } from './status.js';
import { renderMarket } from './views/market.js';
import { renderOrders } from './views/orders.js';
import { renderOverview } from './views/overview.js';
import { renderPortfolio } from './views/portfolio.js';
import {
  emptyReconciliationState,
  renderReconciliation,
  type ReconciliationViewState,
} from './views/reconciliation.js';
import { renderSystem } from './views/system.js';
import type {
  HealthSnapshot,
  MarketSnapshot,
  OrdersSnapshot,
  PortfolioSnapshot,
  ReconciliationResponse,
  SystemSnapshot,
} from './types.js';

export const REFRESH_INTERVALS = {
  status: 10_000,
  portfolio: 10_000,
  orders: 10_000,
  market: 5_000,
  health: 30_000,
  healthz: 10_000,
} as const;

interface DashboardState {
  system: SystemSnapshot | null;
  systemError: string | null;
  portfolio: PortfolioSnapshot | null;
  portfolioError: string | null;
  orders: OrdersSnapshot | null;
  ordersError: string | null;
  market: MarketSnapshot | null;
  marketError: string | null;
  health: HealthSnapshot | null;
  healthError: string | null;
  apiReachable: boolean | null;
  reconciliation: ReconciliationViewState;
}

export class Dashboard {
  private readonly state: DashboardState = {
    system: null,
    systemError: null,
    portfolio: null,
    portfolioError: null,
    orders: null,
    ordersError: null,
    market: null,
    marketError: null,
    health: null,
    healthError: null,
    apiReachable: null,
    reconciliation: emptyReconciliationState(),
  };

  private readonly poller: Poller;
  private readonly controller: ReconcileController;
  private readonly onClick: (event: Event) => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly client: ApiClient = new ApiClient(),
  ) {
    this.controller = new ReconcileController(() => this.runReconciliation());
    this.poller = new Poller([
      { key: 'status', intervalMs: REFRESH_INTERVALS.status, run: () => this.refreshStatus() },
      { key: 'portfolio', intervalMs: REFRESH_INTERVALS.portfolio, run: () => this.refreshPortfolio() },
      { key: 'orders', intervalMs: REFRESH_INTERVALS.orders, run: () => this.refreshOrders() },
      { key: 'market', intervalMs: REFRESH_INTERVALS.market, run: () => this.refreshMarket() },
      { key: 'health', intervalMs: REFRESH_INTERVALS.health, run: () => this.refreshHealth() },
      { key: 'healthz', intervalMs: REFRESH_INTERVALS.healthz, run: () => this.refreshHealthz() },
    ]);

    this.onClick = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-action="reconcile-request"]')) {
        void this.requestReconciliation();
      }
    };
  }

  start(): void {
    this.root.addEventListener('click', this.onClick);
    this.renderAll();
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
    this.root.removeEventListener('click', this.onClick);
  }

  /** Explicit, deduplicated reconciliation request. */
  requestReconciliation(): Promise<boolean> {
    return this.controller.request();
  }

  // --- refresh handlers -----------------------------------------------------

  private async refreshStatus(): Promise<void> {
    const result = await this.client.getStatus();
    if (result.ok && result.data) {
      this.state.system = result.data;
      this.state.systemError = null;
    } else {
      this.state.systemError = result.error ?? `HTTP ${result.status}`;
    }
    this.renderSystemSection();
    this.renderOverviewSection();
  }

  private async refreshPortfolio(): Promise<void> {
    const result = await this.client.getPortfolio();
    if (result.ok && result.data) {
      this.state.portfolio = result.data;
      this.state.portfolioError = null;
    } else {
      this.state.portfolioError = result.error ?? `HTTP ${result.status}`;
    }
    this.renderPortfolioSection();
    this.renderOverviewSection();
  }

  private async refreshOrders(): Promise<void> {
    const result = await this.client.getOrders();
    if (result.ok && result.data) {
      this.state.orders = result.data;
      this.state.ordersError = null;
    } else {
      this.state.ordersError = result.error ?? `HTTP ${result.status}`;
    }
    this.renderOrdersSection();
    this.renderOverviewSection();
  }

  private async refreshMarket(): Promise<void> {
    const result = await this.client.getMarket();
    if (result.ok && result.data) {
      this.state.market = result.data;
      this.state.marketError = null;
    } else {
      this.state.marketError = result.error ?? `HTTP ${result.status}`;
    }
    this.renderMarketSection();
    this.renderOverviewSection();
  }

  private async refreshHealth(): Promise<void> {
    const result: ApiResult<HealthSnapshot> = await this.client.getHealth();
    // A non-OK health is returned with a 503 and a valid HealthSnapshot body;
    // preserve that honest status rather than treating it as an outage.
    if (result.data && typeof result.data.status === 'string') {
      this.state.health = result.data;
      this.state.healthError = null;
    } else {
      this.state.health = null;
      this.state.healthError = result.error ?? `HTTP ${result.status}`;
    }
    this.renderSystemSection();
    this.renderOverviewSection();
  }

  private async refreshHealthz(): Promise<void> {
    const result = await this.client.getHealthz();
    this.state.apiReachable = result.status !== null;
    this.renderOverviewSection();
  }

  private async runReconciliation(): Promise<void> {
    this.state.reconciliation = { ...this.state.reconciliation, pending: true };
    this.renderReconciliationSection();

    const result = await this.client.getReconciliation();
    const requestedAtMs = Date.now();
    const data = result.data as ReconciliationResponse | null;
    if (data && typeof (data as { status?: unknown }).status === 'string') {
      this.state.reconciliation = {
        status: data.status,
        response: data,
        error: null,
        requestedAtMs,
        pending: false,
      };
    } else {
      this.state.reconciliation = {
        status: 'ERROR',
        response: null,
        error: result.error ?? `HTTP ${result.status}`,
        requestedAtMs,
        pending: false,
      };
    }
    this.renderReconciliationSection();
    this.renderOverviewSection();
  }

  // --- rendering ------------------------------------------------------------

  private section(name: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-section="${name}"]`);
  }

  private renderAll(): void {
    this.renderOverviewSection();
    this.renderMarketSection();
    this.renderPortfolioSection();
    this.renderOrdersSection();
    this.renderReconciliationSection();
    this.renderSystemSection();
  }

  private renderHeader(): void {
    const version = this.root.querySelector<HTMLElement>('[data-header="version"]');
    if (version) version.textContent = this.state.system?.config.version ?? '—';

    const mode = this.root.querySelector<HTMLElement>('[data-header="mode"]');
    if (mode) {
      const tradingMode = this.state.system?.config.tradingMode;
      mode.innerHTML = tradingMode
        ? badge(tradingMode.toUpperCase(), tradingMode === 'live' ? 'warn' : 'neutral')
        : '';
    }

    const api = this.root.querySelector<HTMLElement>('[data-header="api"]');
    if (api) {
      api.innerHTML =
        this.state.apiReachable === null
          ? badge('API UNKNOWN', 'neutral')
          : this.state.apiReachable
            ? badge('API OK', 'ok')
            : badge('API DOWN', 'error');
    }

    const ndax = this.root.querySelector<HTMLElement>('[data-header="ndax"]');
    if (ndax) {
      ndax.innerHTML = this.state.health
        ? badge(`NDAX ${this.state.health.status}`, healthTone(this.state.health.status))
        : badge('NDAX UNAVAILABLE', 'unavailable');
    }
  }

  private renderOverviewSection(): void {
    this.renderHeader();
    const el = this.section('overview');
    if (!el) return;
    el.innerHTML = renderOverview({
      system: this.state.system,
      portfolio: this.state.portfolio,
      orders: this.state.orders,
      market: this.state.market,
      health: this.state.health,
      reconciliation: this.state.reconciliation,
      apiReachable: this.state.apiReachable,
    });
  }

  private renderMarketSection(): void {
    const el = this.section('market');
    if (el) el.innerHTML = renderMarket(this.state.market, this.state.marketError);
  }

  private renderPortfolioSection(): void {
    const el = this.section('portfolio');
    if (el) el.innerHTML = renderPortfolio(this.state.portfolio, this.state.portfolioError);
  }

  private renderOrdersSection(): void {
    const el = this.section('orders');
    if (el) el.innerHTML = renderOrders(this.state.orders, this.state.ordersError);
  }

  private renderReconciliationSection(): void {
    const el = this.section('reconciliation');
    if (el) el.innerHTML = renderReconciliation(this.state.reconciliation);
  }

  private renderSystemSection(): void {
    const el = this.section('system');
    if (el) {
      el.innerHTML = renderSystem(
        this.state.system,
        this.state.health,
        this.state.systemError,
        this.state.healthError,
      );
    }
  }
}
