/**
 * Overview landing view: a compact, non-aggregating summary of the major
 * sections. Each tile links to (or duplicates a one-line summary of) its
 * section. No totals are computed across realms.
 */

import { EMPTY, displayMoney, displayText } from '../format.js';
import {
  badge,
  healthTone,
  observationTone,
  reconciliationTone,
  recoveryTone,
} from '../status.js';
import type {
  HealthSnapshot,
  MarketSnapshot,
  OrdersSnapshot,
  PortfolioSnapshot,
  SystemSnapshot,
} from '../types.js';
import { realmSummary } from './portfolio.js';
import type { ReconciliationViewState } from './reconciliation.js';

export interface OverviewInput {
  system: SystemSnapshot | null;
  portfolio: PortfolioSnapshot | null;
  orders: OrdersSnapshot | null;
  market: MarketSnapshot | null;
  health: HealthSnapshot | null;
  reconciliation: ReconciliationViewState;
  /** Process/API reachability derived from the latest status request. */
  apiReachable: boolean | null;
}

interface Tile {
  label: string;
  value: string;
  tone?: Parameters<typeof badge>[1];
  badgeText?: string;
}

function tile(t: Tile): string {
  return `
    <div class="tile">
      <span class="tile__label">${t.label}</span>
      <span class="tile__value">${t.value}${
        t.badgeText && t.tone ? ` ${badge(t.badgeText, t.tone)}` : ''
      }</span>
    </div>`;
}

export function renderOverview(input: OverviewInput): string {
  const { system, portfolio, orders, market, health, reconciliation } = input;
  const cfg = system?.config ?? null;

  const apiTile: Tile = {
    label: 'API / process',
    value:
      input.apiReachable === null
        ? EMPTY
        : input.apiReachable
          ? 'REACHABLE'
          : 'UNREACHABLE',
    badgeText: input.apiReachable === null ? 'UNKNOWN' : undefined,
    tone: input.apiReachable === null ? 'neutral' : undefined,
  };

  const ndaxTile: Tile = {
    label: 'NDAX health',
    value: health ? displayText(health.status) : EMPTY,
    badgeText: health ? health.status : 'UNAVAILABLE',
    tone: health ? healthTone(health.status) : 'unavailable',
  };

  const marketTile: Tile = (() => {
    if (!market || market.status !== 'OK' || market.last === null) {
      return { label: 'BTC/CAD market', value: EMPTY, badgeText: 'UNAVAILABLE', tone: 'unavailable' };
    }
    return {
      label: `Market ${displayText(market.symbol)}`,
      value: `${displayMoney(market.last)}`,
      badgeText: market.stale ? 'STALE' : 'FRESH',
      tone: market.stale ? 'warn' : 'ok',
    };
  })();

  const recoveryTile: Tile = {
    label: 'Recovery',
    value: system ? displayText(system.recovery.status) : EMPTY,
    badgeText: system ? system.recovery.status : 'UNAVAILABLE',
    tone: system ? recoveryTone(system.recovery.status) : 'unavailable',
  };

  const tiles: Tile[] = [
    { label: 'Application', value: cfg ? `${displayText(cfg.version)} · ${displayText(cfg.exchange)}` : EMPTY },
    {
      label: 'Mode',
      value: cfg ? displayText(cfg.tradingMode.toUpperCase()) : EMPTY,
      badgeText: cfg ? (cfg.tradingMode === 'live' ? 'LIVE' : 'PAPER') : undefined,
      tone: cfg ? (cfg.tradingMode === 'live' ? 'warn' : 'neutral') : undefined,
    },
    {
      label: 'Initialization',
      value: system ? displayText(system.init.status) : EMPTY,
      badgeText: system ? system.init.status : 'UNAVAILABLE',
      tone: system ? observationTone(system.init.status) : 'unavailable',
    },
    {
      label: 'Mutation lock',
      value: system ? (system.lock.held ? 'HELD' : 'RELEASED') : EMPTY,
      badgeText: system ? (system.lock.held ? 'HELD' : 'RELEASED') : undefined,
      tone: system ? (system.lock.held ? 'warn' : 'ok') : undefined,
    },
    recoveryTile,
    {
      label: 'Unresolved orders',
      value: orders ? displayText(String(orders.unresolvedCount)) : EMPTY,
      badgeText: orders && orders.status !== 'OK' ? orders.status : undefined,
      tone: orders && orders.status !== 'OK' ? observationTone(orders.status) : undefined,
    },
    apiTile,
    ndaxTile,
    marketTile,
    {
      label: 'LIVE portfolio',
      value: portfolio ? realmSummary(portfolio.live) : EMPTY,
      badgeText: portfolio ? portfolio.live.status : 'UNAVAILABLE',
      tone: portfolio ? observationTone(portfolio.live.status) : 'unavailable',
    },
    {
      label: 'PAPER portfolio',
      value: portfolio ? realmSummary(portfolio.paper) : EMPTY,
      badgeText: portfolio ? portfolio.paper.status : 'UNAVAILABLE',
      tone: portfolio ? observationTone(portfolio.paper.status) : 'unavailable',
    },
    {
      label: 'Reconciliation',
      value: reconciliation.status === 'NOT_REQUESTED' ? 'not requested' : displayText(reconciliation.status),
      badgeText:
        reconciliation.status === 'NOT_REQUESTED' ? 'NOT REQUESTED' : reconciliation.status,
      tone: reconciliationTone(reconciliation.status),
    },
  ];

  return `
    <h2 id="overview-heading">Overview</h2>
    <p class="hint">Operational, read-only summary. LIVE and PAPER balances are never combined.</p>
    <div class="tile-grid">${tiles.map(tile).join('')}</div>`;
}
