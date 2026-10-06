/**
 * Reconciliation section. This is a read-only OBSERVATION of the existing
 * reconciliation entry point — it NEVER commits accounting or mutates state.
 *
 * Reconciliation is requested ONLY by explicit user action (never polled).
 */

import { EMPTY, displayMoney, displayText, formatTimestamp } from '../format.js';
import { badge, provenanceLine, reconciliationTone } from '../status.js';
import type {
  ReconciliationResponse,
  ReconciliationStatus,
} from '../types.js';

export interface ReconciliationViewState {
  /** Local UI status; NOT_REQUESTED is client-side only. */
  status: ReconciliationStatus | 'NOT_REQUESTED';
  response: ReconciliationResponse | null;
  error: string | null;
  requestedAtMs: number | null;
  pending: boolean;
}

export function emptyReconciliationState(): ReconciliationViewState {
  return {
    status: 'NOT_REQUESTED',
    response: null,
    error: null,
    requestedAtMs: null,
    pending: false,
  };
}

function balancesTable(response: ReconciliationResponse): string {
  const result = response.result;
  if (!result || result.balanceFindings.length === 0) {
    return `<p class="empty">${EMPTY} no balance findings</p>`;
  }
  const rows = result.balanceFindings
    .map(
      (b) => `
      <tr>
        <th scope="row">${displayText(b.currency)}</th>
        <td class="num">${displayMoney(b.expected)}</td>
        <td class="num">${displayMoney(b.observed)}</td>
        <td>${badge(b.mismatch ? 'MISMATCH' : 'MATCH', b.mismatch ? 'error' : 'ok')}</td>
        <td>${displayText(b.reason)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="data">
      <caption class="sr-only">Reconciliation balance findings</caption>
      <thead>
        <tr><th scope="col">Currency</th><th scope="col">Expected</th>
        <th scope="col">Observed</th><th scope="col">Result</th><th scope="col">Reason</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function findingsBlock(response: ReconciliationResponse): string {
  const result = response.result;
  if (!result) return '';
  const sections: string[] = [];

  if (result.reasons.length > 0) {
    sections.push(
      `<h4>Reasons</h4><ul class="finding-list">${result.reasons
        .map((r) => `<li>${displayText(r)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (result.readFailures.length > 0) {
    sections.push(
      `<h4>Read failures</h4><ul class="finding-list finding-list--error">${result.readFailures
        .map((r) => `<li>${displayText(r)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (result.operatorFindings.length > 0) {
    sections.push(
      `<h4>Operator findings</h4><ul class="finding-list finding-list--warn">${result.operatorFindings
        .map((f) => `<li><strong>${displayText(f.kind)}</strong>: ${displayText(f.detail)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (result.orderFindings.length > 0) {
    sections.push(
      `<h4>Order findings</h4><ul class="finding-list">${result.orderFindings
        .map(
          (f) =>
            `<li>${displayText(f.clientOrderId)}: ${displayText(f.disposition)} (${displayText(
              f.completeness,
            )}) — ${displayText(f.reason)}</li>`,
        )
        .join('')}</ul>`,
    );
  }
  if (result.executionFindings.length > 0) {
    sections.push(
      `<h4>Execution findings</h4><ul class="finding-list">${result.executionFindings
        .map(
          (f) =>
            `<li>${displayText(f.executionId)} ${displayText(f.correlation)} (${displayText(
              f.completeness,
            )}) — ${displayText(f.reason)}</li>`,
        )
        .join('')}</ul>`,
    );
  }
  if (result.reservationFindings.length > 0) {
    sections.push(
      `<h4>Reservation findings</h4><ul class="finding-list">${result.reservationFindings
        .map((f) => `<li>${displayText(f.orderId)}: ${displayText(f.disposition)}</li>`)
        .join('')}</ul>`,
    );
  }

  sections.push(
    `<h4>Balance findings</h4>${balancesTable(response)}`,
    `<p class="detail-line">commit candidates: ${result.commitCandidates.length} · reservation releases: ${
      result.reservationReleases.length
    } · canCommit: ${result.canCommit ? 'YES' : 'NO'}</p>`,
  );
  return sections.join('');
}

export function renderReconciliation(state: ReconciliationViewState): string {
  const tone = reconciliationTone(state.status);
  const label = state.status === 'NOT_REQUESTED' ? 'NOT REQUESTED' : state.status;

  const button = `
    <button
      type="button"
      class="btn"
      data-action="reconcile-request"
      aria-label="Request read-only reconciliation"
      ${state.pending ? 'disabled aria-busy="true"' : ''}
    >${state.pending ? 'Requesting…' : 'Request read-only reconciliation'}</button>`;

  let body = '';
  if (state.status === 'NOT_REQUESTED') {
    body = `<p class="hint">Reconciliation has not been requested. It is never run automatically and never mutates accounting.</p>`;
  } else if (state.error) {
    body = `<p class="section-error" role="status">Reconciliation request failed: ${displayText(
      state.error,
    )}. The previous state is unknown — this is NOT a clean reconciliation.</p>`;
  } else if (state.status === 'UNAVAILABLE') {
    body = `<p class="section-error" role="status">Reconciliation is UNAVAILABLE (no exchange adapter or read unavailable).</p>`;
  } else if (state.status === 'ERROR') {
    body = `<p class="section-error" role="status">Reconciliation read failed (ERROR). This is not a clean state.</p>`;
  } else if (state.response?.result) {
    body = `${findingsBlock(state.response)}${provenanceLine(state.response.provenance)}`;
  } else {
    body = `<p class="hint">Reconciliation status: ${displayText(state.status)}${
      state.response?.error ? ` — ${displayText(state.response.error)}` : ''
    }</p>`;
  }

  return `
    <h2 id="reconciliation-heading">Reconciliation</h2>
    <div class="recon">
      <div class="recon__header">
        <div>
          ${badge(label, tone)}
          <span class="recon__requested">${
            state.requestedAtMs === null
              ? 'never requested'
              : `last requested ${formatTimestamp(state.requestedAtMs)}`
          }</span>
        </div>
        ${button}
      </div>
      <p class="notice" role="note">
        Read-only observation. This view does not commit accounting, resolve orders,
        release reservations, or mutate any state.
      </p>
      <div class="recon__body">${body}</div>
    </div>`;
}
