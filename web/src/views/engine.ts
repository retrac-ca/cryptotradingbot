/**
 * Engine panel: live heartbeat (running/halted/orders/equity) and the durable
 * equity-curve history. Read-only presentation; no trading controls.
 *
 * The sparkline geometry parses the decimal strings to JS numbers ONLY for
 * pixel scaling — it is never used for accounting, and displayed values remain
 * the exact strings from the API.
 */

import { EMPTY, displayText, escapeHtml, formatTimestamp } from '../format.js';
import { badge, observationTone } from '../status.js';
import type { EngineStatusSnapshot, EquityCurveSnapshot } from '../types.js';

function sparkline(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return '';
  const width = 560;
  const height = 90;
  const pad = 6;
  const coords = points
    .map((p) => `${(pad + p.x * (width - pad * 2)).toFixed(1)},${(pad + (1 - p.y) * (height - pad * 2)).toFixed(1)}`)
    .join(' ');
  const up = points[points.length - 1]!.y >= points[0]!.y;
  const stroke = up ? '#3fb950' : '#f85149';
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="equity curve"><polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="2" /></svg>`;
}

export function renderEngine(
  engine: EngineStatusSnapshot | null,
  equity: EquityCurveSnapshot | null,
  error: string | null,
): string {
  if (!engine) {
    return `
      <h2 id="engine-heading">Engine</h2>
      <p class="section-error" role="status">ENGINE ${badge('UNAVAILABLE', 'unavailable')} ${
        error ? `— ${displayText(error)}` : ''
      }</p>`;
  }

  const statusBadge = badge(engine.status, observationTone(engine.status));
  const stateBadge =
    engine.halted === true
      ? badge('HALTED', 'error')
      : engine.running === true
        ? badge('RUNNING', 'ok')
        : engine.running === false
          ? badge('STOPPED', 'neutral')
          : badge('UNKNOWN', 'neutral');

  const curve = equity && equity.status === 'OK' && equity.samples.length > 0
    ? `
      <h3>Equity curve</h3>
      <p class="hint">${equity.samples.length} samples · first ${escapeHtml(
        equity.samples[0]!.equity,
      )} · latest <strong>${escapeHtml(
        equity.latestEquity ?? equity.samples[equity.samples.length - 1]!.equity,
      )}</strong></p>
      ${sparkline(equity.points)}`
    : `
      <h3>Equity curve</h3>
      <p class="hint">${displayText(equity?.reason ?? 'No equity history yet.')}</p>`;

  return `
    <h2 id="engine-heading">Engine</h2>
    <table class="kv">
      <caption class="sr-only">Engine heartbeat</caption>
      <tbody>
        <tr><th scope="row">Heartbeat</th><td>${statusBadge} ${stateBadge}</td></tr>
        <tr><th scope="row">Engine</th><td>${displayText(engine.kind)}</td></tr>
        <tr><th scope="row">Updated</th><td>${formatTimestamp(engine.updatedAtMs)}${
          engine.ageMs !== null ? ` (${Math.round(engine.ageMs / 1000)}s ago)` : ''
        }</td></tr>
        <tr><th scope="row">Last cycle</th><td>${formatTimestamp(engine.lastEvaluateMs)}</td></tr>
        <tr><th scope="row">Orders placed</th><td>${engine.ordersPlaced ?? EMPTY}</td></tr>
        <tr><th scope="row">Managed equity</th><td>${displayText(engine.equity)}</td></tr>
        <tr><th scope="row">Last reconcile</th><td>${displayText(engine.lastReconciliationStatus)}</td></tr>
      </tbody>
    </table>
    ${engine.haltReason ? `<p class="section-error" role="status">Halt reason: ${displayText(engine.haltReason)}</p>` : ''}
    ${engine.status !== 'OK' && engine.reason ? `<p class="hint">${displayText(engine.reason)}</p>` : ''}
    ${curve}`;
}
