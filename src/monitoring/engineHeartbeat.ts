/**
 * Engine heartbeat/status file.
 *
 * The running trading engine (paper or live) periodically writes a small status
 * record under STATE_DIR. The separate READ-ONLY dashboard process reads it to
 * report live engine health (running/halted/last cycle/errors). This is a
 * one-writer/one-reader file: the engine is the only writer.
 *
 * It carries no secrets — only operational status.
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EngineStatusRecord {
  /** Which engine wrote this record. */
  kind: 'paper' | 'live';
  /** Local time the record was written. */
  updatedAtMs: number;
  /** Engine-specific status payload (opaque to the reader beyond this shape). */
  status: Record<string, unknown>;
}

export type EngineStatusLoad =
  | { status: 'OK'; data: EngineStatusRecord }
  | { status: 'MISSING' }
  | { status: 'CORRUPT'; reason: string };

/** Atomically write the engine status record (temp + rename). */
export function writeEngineStatus(filePath: string, record: EngineStatusRecord): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), 'utf8');
  renameSync(tmp, filePath);
}

/** Read the engine status record. Missing/corrupt is surfaced, never invented. */
export function readEngineStatus(filePath: string): EngineStatusLoad {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { status: 'MISSING' };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'CORRUPT', reason: 'engine status is not an object' };
    }
    const r = parsed as Partial<EngineStatusRecord>;
    if ((r.kind !== 'paper' && r.kind !== 'live') || typeof r.updatedAtMs !== 'number' || typeof r.status !== 'object' || r.status === null) {
      return { status: 'CORRUPT', reason: 'engine status shape is invalid' };
    }
    return { status: 'OK', data: r as EngineStatusRecord };
  } catch (err) {
    return { status: 'CORRUPT', reason: err instanceof Error ? err.message : String(err) };
  }
}
