/**
 * Market section. Renders BTC/CAD quote data with honest
 * FRESH / STALE / UNAVAILABLE handling. Never invents a price or shows 0.
 */

import {
  EMPTY,
  displayMoney,
  displayText,
  formatDurationMs,
  formatTimestamp,
} from '../format.js';
import { badge, observationTone, provenanceLine } from '../status.js';
import type { MarketSnapshot } from '../types.js';

function freshnessBadge(market: MarketSnapshot): string {
  if (market.status !== 'OK' || !market.symbol) return badge('UNAVAILABLE', 'unavailable');
  if (market.stale) return badge('STALE', 'warn');
  return badge('FRESH', 'ok');
}

function valueOrUnavailable(value: string | null): string {
  return value === null || value === '' ? badge('UNAVAILABLE', 'unavailable') : displayMoney(value);
}

export function renderMarket(market: MarketSnapshot | null, error: string | null): string {
  if (!market) {
    return `
      <h2 id="market-heading">Market</h2>
      <p class="section-error" role="status">MARKET ${badge('UNAVAILABLE', 'error')} ${
        error ? `— ${displayText(error)}` : '— no data received'
      }</p>`;
  }

  const stale = market.status !== 'OK' || market.stale;
  const statusLabel = market.status === 'OK' ? (stale ? 'OK (STALE)' : 'OK') : market.status;

  const details: string[] = [];
  if (market.staleReason) details.push(`stale reason: ${displayText(market.staleReason)}`);
  if (market.lastError) details.push(`last error: ${displayText(market.lastError)}`);
  if (market.reason) details.push(`reason: ${displayText(market.reason)}`);
  if (market.quoteAgeMs !== null) details.push(`quote age: ${formatDurationMs(market.quoteAgeMs)}`);
  if (market.transportAgeMs !== null) {
    details.push(`transport age: ${formatDurationMs(market.transportAgeMs)}`);
  }
  if (market.quoteTimestampMs !== null) {
    details.push(`quote time: ${formatTimestamp(market.quoteTimestampMs)}`);
  }

  return `
    <h2 id="market-heading">Market</h2>
    <div class="market-grid">
      <div class="metric">
        <span class="metric__label">Symbol</span>
        <span class="metric__value">${displayText(market.symbol)}</span>
      </div>
      <div class="metric">
        <span class="metric__label">Last</span>
        <span class="metric__value metric__value--price">${valueOrUnavailable(market.last)}</span>
      </div>
      <div class="metric">
        <span class="metric__label">Bid</span>
        <span class="metric__value">${valueOrUnavailable(market.bid)}</span>
      </div>
      <div class="metric">
        <span class="metric__label">Ask</span>
        <span class="metric__value">${valueOrUnavailable(market.ask)}</span>
      </div>
      <div class="metric">
        <span class="metric__label">Spread</span>
        <span class="metric__value">${displayMoney(market.spread)}</span>
      </div>
      <div class="metric">
        <span class="metric__label">Spread %</span>
        <span class="metric__value">${
          market.spreadPct === null ? EMPTY : `${displayMoney(market.spreadPct)}%`
        }</span>
      </div>
      <div class="metric metric--status">
        <span class="metric__label">Data status</span>
        <span class="metric__value">
          ${badge(statusLabel, observationTone(market.status))}
          ${freshnessBadge(market)}
        </span>
      </div>
    </div>
    ${details.length > 0 ? `<p class="detail-line">${details.join(' · ')}</p>` : ''}
    <p class="stale-notice" ${stale ? '' : 'hidden'}>
      Values above are STALE and must not be treated as current.
    </p>
    ${provenanceLine(market.provenance)}`;
}
