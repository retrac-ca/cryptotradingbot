/**
 * Status → tone mapping and badge rendering.
 *
 * Color is never the only signal: every badge carries an explicit text label.
 */

import { escapeHtml } from './format.js';
import type {
  ObservationStatus,
  Provenance,
  RecoveryStatus,
  ValueKind,
} from './types.js';

export type Tone = 'ok' | 'warn' | 'error' | 'unavailable' | 'neutral';

/** Map a read-model observation status to a visual tone. */
export function observationTone(status: ObservationStatus | null | undefined): Tone {
  switch (status) {
    case 'OK':
      return 'ok';
    case 'MISSING':
      return 'unavailable';
    case 'CORRUPT':
    case 'ERROR':
      return 'error';
    case 'UNAVAILABLE':
      return 'unavailable';
    default:
      return 'neutral';
  }
}

export function recoveryTone(status: RecoveryStatus | null | undefined): Tone {
  switch (status) {
    case 'READY':
      return 'ok';
    case 'RECONCILIATION_REQUIRED':
      return 'warn';
    case 'HALTED':
      return 'error';
    case 'UNAVAILABLE':
      return 'unavailable';
    default:
      return 'neutral';
  }
}

export function healthTone(status: ObservationStatus | null | undefined): Tone {
  return observationTone(status);
}

/**
 * Tone for an order lifecycle status. Uses the ACTUAL status string from the
 * API; unknown values fall back to a neutral tone but are still shown verbatim.
 */
export function orderTone(status: string | null | undefined): Tone {
  switch ((status ?? '').toUpperCase()) {
    case 'FILLED':
      return 'ok';
    case 'PARTIALLY_FILLED':
      return 'warn';
    case 'OPEN':
    case 'SUBMITTED':
    case 'CREATED':
      return 'neutral';
    case 'UNKNOWN':
      return 'error';
    case 'CANCELLED':
    case 'CANCELED':
    case 'EXPIRED':
    case 'CLOSED':
      return 'neutral';
    case 'REJECTED':
    case 'FAILED':
    case 'ERROR':
      return 'error';
    default:
      return 'neutral';
  }
}

export function reconciliationTone(
  status: 'READY' | 'RECONCILIATION_REQUIRED' | 'HALTED' | 'ERROR' | 'UNAVAILABLE' | 'NOT_REQUESTED',
): Tone {
  switch (status) {
    case 'READY':
      return 'ok';
    case 'RECONCILIATION_REQUIRED':
      return 'warn';
    case 'HALTED':
    case 'ERROR':
      return 'error';
    case 'UNAVAILABLE':
      return 'unavailable';
    default:
      return 'neutral';
  }
}

/** A status pill: explicit text plus a tone class (never color alone). */
export function badge(label: string, tone: Tone): string {
  return `<span class="badge badge--${tone}">${escapeHtml(label)}</span>`;
}

const VALUE_KIND_LABELS: Record<ValueKind, string> = {
  managed_state: 'Persisted managed state',
  exchange_read: 'Exchange observation',
  derived: 'Derived / reconciliation',
  unavailable: 'Unavailable',
  error: 'Error',
};

/** Human label describing the authority/source of a value. */
export function provenanceLabel(prov: Provenance | null | undefined): string {
  if (!prov) return 'Unknown source';
  return VALUE_KIND_LABELS[prov.kind] ?? prov.kind;
}

/**
 * A compact provenance/freshness line: source authority, as-of time, and a
 * stale marker. Kept intentionally visible so persisted state is never mistaken
 * for a fresh exchange read.
 */
export function provenanceLine(prov: Provenance | null | undefined): string {
  if (!prov) return '';
  const parts: string[] = [escapeHtml(provenanceLabel(prov))];
  if (prov.asOfMs !== null) {
    parts.push(`as of ${escapeHtml(new Date(prov.asOfMs).toISOString())}`);
  }
  if (prov.stale || prov.kind === 'unavailable') {
    parts.push(badge('STALE', 'warn'));
  }
  if (prov.detail) parts.push(escapeHtml(prov.detail));
  return `<p class="provenance">source: ${parts.join(' · ')}</p>`;
}
