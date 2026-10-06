/**
 * Portfolio section. LIVE, PAPER, external/unmanaged, and authorized-external
 * balances are rendered in strictly separate blocks. No totals are combined and
 * no P&L is recomputed — only values returned by the API are shown.
 */

import { EMPTY, displayMoney, displayText, formatTimestamp } from '../format.js';
import { badge, observationTone, provenanceLine } from '../status.js';
import type { PortfolioRealmSnapshot, PortfolioSnapshot } from '../types.js';

function cashTable(cash: Record<string, string> | null): string {
  if (!cash || Object.keys(cash).length === 0) {
    return `<p class="empty">${EMPTY} no cash entries</p>`;
  }
  const rows = Object.entries(cash)
    .map(
      ([currency, amount]) =>
        `<tr><th scope="row">${displayText(currency)}</th><td class="num">${displayMoney(
          amount,
        )}</td></tr>`,
    )
    .join('');
  return `<table class="kv"><caption class="sr-only">Managed cash balances</caption><tbody>${rows}</tbody></table>`;
}

function positionsTable(realm: PortfolioRealmSnapshot): string {
  const positions = realm.positions;
  if (!positions || positions.length === 0) {
    return `<p class="empty">${EMPTY} no managed positions</p>`;
  }
  const rows = positions
    .map(
      (p) => `
      <tr>
        <th scope="row">${displayText(p.symbol)}</th>
        <td class="num">${displayMoney(p.quantity)}</td>
        <td class="num">${displayMoney(p.averageEntryPrice)}</td>
        <td>${displayText(p.source)}</td>
        <td class="num">BOT ${displayMoney(p.sourceQuantities.BOT)}</td>
        <td class="num">EXT ${displayMoney(p.sourceQuantities.EXTERNAL_AUTHORIZED)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="data">
      <caption class="sr-only">Managed positions (BOT and external split kept separate)</caption>
      <thead>
        <tr>
          <th scope="col">Symbol</th><th scope="col">Qty</th><th scope="col">Avg entry</th>
          <th scope="col">Source</th><th scope="col">BOT qty</th><th scope="col">External qty</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function externalBlock(realm: PortfolioRealmSnapshot): string {
  const snapshot = realm.externalSnapshot;
  const rows =
    snapshot && Object.keys(snapshot).length > 0
      ? Object.entries(snapshot)
          .map(
            ([currency, amount]) =>
              `<tr><th scope="row">${displayText(currency)}</th><td class="num">${displayMoney(
                amount,
              )}</td></tr>`,
          )
          .join('')
      : `<tr><td colspan="2" class="empty">${EMPTY} none observed</td></tr>`;
  return `
    <div class="subcard subcard--external">
      <h4>EXTERNAL / UNMANAGED</h4>
      <p class="hint">Observed on the exchange but NOT managed by the bot. Never added to managed balances.</p>
      <table class="kv"><tbody>${rows}</tbody></table>
    </div>`;
}

function authorizedExternalBlock(realm: PortfolioRealmSnapshot): string {
  const authorized = realm.authorizedExternal;
  const list =
    authorized && authorized.length > 0
      ? `<ul class="tag-list">${authorized
          .map((symbol) => `<li class="tag">${displayText(symbol)}</li>`)
          .join('')}</ul>`
      : `<p class="empty">${EMPTY} none</p>`;
  return `
    <div class="subcard subcard--authorized">
      <h4>AUTHORIZED EXTERNAL</h4>
      <p class="hint">External inventory explicitly authorized for bot operations. Tracked separately from BOT inventory.</p>
      ${list}
    </div>`;
}

function pnlBlock(realm: PortfolioRealmSnapshot): string {
  const rows = [
    ['Peak equity', realm.peakEquity],
    ['Realized P&L', realm.realizedPnl],
    ['Daily realized P&L', realm.dailyRealizedPnl],
    ['Total fees', realm.totalFees],
  ] as const;
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${displayText(label)}</th><td class="num">${displayMoney(value)}</td></tr>`,
    )
    .join('');
  return `<table class="kv"><caption class="sr-only">Reported P&amp;L and fees</caption><tbody>${body}</tbody></table>`;
}

function realmCard(realm: PortfolioRealmSnapshot): string {
  const heading = realm.realm === 'live' ? 'LIVE PORTFOLIO' : 'PAPER PORTFOLIO';
  const roleClass = realm.realm === 'live' ? 'realm-card--live' : 'realm-card--paper';
  const tone = observationTone(realm.status);

  if (realm.status === 'MISSING') {
    return `
      <article class="realm-card ${roleClass}">
        <header class="realm-card__header">
          <h3>${heading}</h3>${badge('MISSING', 'unavailable')}
        </header>
        <p class="empty">${EMPTY} ${displayText(realm.reason ?? 'no state')}</p>
        ${provenanceLine(realm.provenance)}
      </article>`;
  }
  if (realm.status === 'CORRUPT' || realm.status === 'ERROR') {
    return `
      <article class="realm-card ${roleClass}">
        <header class="realm-card__header">
          <h3>${heading}</h3>${badge(realm.status, 'error')}
        </header>
        <p class="section-error" role="status">State is ${displayText(realm.status)}: ${displayText(
          realm.reason ?? 'unreadable',
        )}</p>
        ${provenanceLine(realm.provenance)}
      </article>`;
  }

  const fee = realm.provenance;
  return `
    <article class="realm-card ${roleClass}">
      <header class="realm-card__header">
        <h3>${heading}</h3>${badge(realm.status, tone)}
      </header>
      <h4>Cash</h4>
      ${cashTable(realm.cash)}
      <h4>Positions</h4>
      ${positionsTable(realm)}
      <h4>Reported P&amp;L / fees</h4>
      ${pnlBlock(realm)}
      ${externalBlock(realm)}
      ${authorizedExternalBlock(realm)}
      ${
        realm.dailyRealizedDayKey
          ? `<p class="detail-line">daily P&amp;L day key: ${displayText(realm.dailyRealizedDayKey)}</p>`
          : ''
      }
      ${provenanceLine(fee)}
    </article>`;
}

export function renderPortfolio(
  portfolios: PortfolioSnapshot | null,
  error: string | null,
): string {
  if (!portfolios) {
    return `
      <h2 id="portfolio-heading">Portfolio</h2>
      <p class="section-error" role="status">PORTFOLIO ${badge(
        'UNAVAILABLE',
        'error',
      )} ${error ? `— ${displayText(error)}` : ''}</p>`;
  }
  return `
    <h2 id="portfolio-heading">Portfolio</h2>
    <p class="hint">LIVE and PAPER are separate realms. Balances are never combined.</p>
    <div class="realm-grid">
      ${realmCard(portfolios.live)}
      ${realmCard(portfolios.paper)}
    </div>`;
}

/** Exported for the overview summary (kept minimal and non-aggregating). */
export function realmSummary(realm: PortfolioRealmSnapshot | null | undefined): string {
  if (!realm) return EMPTY;
  if (realm.status !== 'OK') return displayText(realm.status);
  const cashEntries = realm.cash ? Object.entries(realm.cash) : [];
  if (cashEntries.length === 0) return formatTimestamp(realm.provenance.asOfMs);
  return cashEntries.map(([c, v]) => `${displayText(c)} ${displayMoney(v)}`).join(' · ');
}
