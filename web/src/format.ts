/**
 * Presentation-only formatting helpers.
 *
 * FINANCIAL SAFETY: monetary values are exact decimal STRINGS from the API.
 * This module NEVER parses them as floating point and NEVER performs
 * arithmetic on them. `groupDecimal` only inserts thousands separators via
 * string manipulation, preserving the exact digits. Missing values render as an
 * em dash — never `0`.
 */

/** HTML-escape arbitrary text before interpolation into an HTML string. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

/** The placeholder used everywhere a real value is absent (never `0`). */
export const EMPTY = '—';

/**
 * Insert thousands separators into the integer part of a plain decimal string.
 * Pure string operation: no `Number()`, no precision loss. Non-decimal input is
 * returned unchanged (and must still be escaped by the caller).
 */
export function groupDecimal(value: string): string {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(trimmed);
  if (!match) return value;
  const sign = match[1] ?? '';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? '';
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${fracPart}`;
}

/** Display a monetary/quantity string exactly; `null`/`undefined` -> em dash. */
export function displayMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  return escapeHtml(groupDecimal(value));
}

/** Display arbitrary text; empty/missing -> em dash. */
export function displayText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  return escapeHtml(value);
}

/** ISO-8601 timestamp for an epoch-millisecond value, or em dash. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EMPTY;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return escapeHtml(date.toISOString().replace('T', ' ').replace('Z', ' UTC'));
}

/** Human-readable duration from milliseconds. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return EMPTY;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

/** Render a boolean tri-state truthfully (`null` is unknown, not false). */
export function displayTriState(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  return value ? 'YES' : 'NO';
}

/** True when a hex string should be used for `title` provenance hints. */
export function attr(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return escapeHtml(value);
}
