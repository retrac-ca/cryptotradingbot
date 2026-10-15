/**
 * Durable equity-curve history.
 *
 * A tiny append-only JSONL store under STATE_DIR. The running engine appends one
 * sample per cycle (or per change); the READ-ONLY dashboard reads the tail to
 * render a live equity curve. One writer (the engine), one reader (dashboard).
 *
 * Values are EXACT decimal strings (never floating point). A malformed line is
 * skipped on read (it is a presentation series), but a file read error is
 * surfaced distinctly.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EquitySample {
  atMs: number;
  /** Total managed equity (quote) at `atMs`, exact decimal string. */
  equity: string;
  /** Managed cash by currency, exact decimal strings. */
  cash: Record<string, string>;
  /** Optional human note (e.g. 'fill', 'cycle'). */
  note?: string;
}

export type EquityHistoryLoad =
  | { status: 'OK'; samples: EquitySample[] }
  | { status: 'MISSING' }
  | { status: 'ERROR'; reason: string };

/** Append one sample as a JSON line (creates the directory/file as needed). */
export function appendEquitySample(filePath: string, sample: EquitySample): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(sample)}\n`, 'utf8');
}

/** Read up to the last `limit` valid samples. */
export function readEquityHistory(filePath: string, limit = 500): EquityHistoryLoad {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { status: 'MISSING' };
  }
  const samples: EquitySample[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const s = parsed as Partial<EquitySample>;
      if (typeof s.atMs !== 'number' || typeof s.equity !== 'string' || typeof s.cash !== 'object' || s.cash === null) {
        continue;
      }
      samples.push(s as EquitySample);
    } catch {
      // Skip a malformed line rather than failing the whole series.
    }
  }
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
  return { status: 'OK', samples: samples.slice(-n) };
}
