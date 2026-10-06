/**
 * System / Health section. Non-secret operational state only. Credentials are
 * never present in the API or the UI.
 */

import {
  EMPTY,
  displayText,
  displayTriState,
  formatDurationMs,
  formatTimestamp,
} from '../format.js';
import { badge, healthTone, observationTone, provenanceLine, recoveryTone } from '../status.js';
import type { HealthSnapshot, SystemSnapshot } from '../types.js';

function listOrNone(values: string[]): string {
  if (values.length === 0) return `<span class="empty">${EMPTY} none</span>`;
  return `<ul class="finding-list">${values.map((v) => `<li>${displayText(v)}</li>`).join('')}</ul>`;
}

export function renderSystem(
  system: SystemSnapshot | null,
  health: HealthSnapshot | null,
  statusError: string | null,
  healthError: string | null,
): string {
  if (!system) {
    return `
      <h2 id="system-heading">System</h2>
      <p class="section-error" role="status">SYSTEM ${badge('UNAVAILABLE', 'error')} ${
        statusError ? `— ${displayText(statusError)}` : ''
      }</p>`;
  }

  const cfg = system.config;
  const recovery = system.recovery;
  const init = system.init;

  const healthBlock = health
    ? `
      <table class="kv">
        <caption class="sr-only">NDAX health</caption>
        <tbody>
          <tr><th scope="row">NDAX health</th><td>${badge(health.status, healthTone(health.status))}</td></tr>
          <tr><th scope="row">Connected</th><td>${displayTriState(health.connected)}</td></tr>
          <tr><th scope="row">Latency</th><td>${formatDurationMs(health.latencyMs)}</td></tr>
          <tr><th scope="row">Authenticated reads enabled</th><td>${displayTriState(
            health.authenticatedReadsEnabled,
          )}</td></tr>
          <tr><th scope="row">Checked at</th><td>${formatTimestamp(health.checkedAtMs)}</td></tr>
          <tr><th scope="row">Detail</th><td>${displayText(health.detail ?? health.error)}</td></tr>
        </tbody>
      </table>
      ${health.error ? `<p class="section-error" role="status">NDAX health error: ${displayText(health.error)}</p>` : ''}`
    : `<p class="section-error" role="status">NDAX health ${badge('UNAVAILABLE', 'error')} ${
        healthError ? `— ${displayText(healthError)}` : ''
      }</p>`;

  return `
    <h2 id="system-heading">System</h2>
    <div class="system-grid">
      <table class="kv">
        <caption class="sr-only">Application status</caption>
        <tbody>
          <tr><th scope="row">Version</th><td>${displayText(cfg.version)}</td></tr>
          <tr><th scope="row">Mode</th><td>${badge(
            cfg.tradingMode.toUpperCase(),
            cfg.tradingMode === 'live' ? 'warn' : 'neutral',
          )}</td></tr>
          <tr><th scope="row">Exchange</th><td>${displayText(cfg.exchange)}</td></tr>
          <tr><th scope="row">Strategy</th><td>${displayText(cfg.strategy)} · ${displayText(
            cfg.timeframe,
          )}</td></tr>
          <tr><th scope="row">Kill switch</th><td>${displayTriState(cfg.killSwitch)}</td></tr>
          <tr><th scope="row">Initialization</th><td>${badge(init.status, observationTone(init.status))}
            paper ${displayTriState(init.paper)} · live ${displayTriState(init.live)}${
              init.reason ? ` — ${displayText(init.reason)}` : ''
            }</td></tr>
          <tr><th scope="row">Mutation lock</th><td>${
            system.lock.held
              ? badge('HELD', 'warn')
              : badge('RELEASED', 'ok')
          }</td></tr>
          <tr><th scope="row">Recovery</th><td>${badge(
            recovery.status,
            recoveryTone(recovery.status),
          )}${recovery.reason ? ` — ${displayText(recovery.reason)}` : ''}</td></tr>
          <tr><th scope="row">Requires exchange read</th><td>${displayTriState(
            recovery.requiresExchangeRead,
          )}</td></tr>
        </tbody>
      </table>
      <div class="system-grid__health">
        <h3>NDAX / API health</h3>
        ${healthBlock}
      </div>
    </div>
    <div class="system-grid__lists">
      <div><h4>Recovery reasons</h4>${listOrNone(recovery.reasons)}</div>
      <div><h4>Unresolved orders (${recovery.unresolvedOrders.length})</h4>${listOrNone(
        recovery.unresolvedOrders,
      )}</div>
      <div><h4>Unresolved reservations (${recovery.unresolvedReservations.length})</h4>${listOrNone(
        recovery.unresolvedReservations,
      )}</div>
      <div><h4>Unresolved intents (${recovery.unresolvedIntents.length})</h4>${listOrNone(
        recovery.unresolvedIntents,
      )}</div>
      <div><h4>Cross-file issues</h4>${listOrNone(recovery.crossFileIssues)}</div>
    </div>
    ${provenanceLine(system.provenance)}`;
}
