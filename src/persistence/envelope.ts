/**
 * State envelope read/write helpers (Persistence & Restart Recovery).
 *
 * Every durable domain file is a versioned envelope:
 *
 *   { "format":"retrac-state", "version":1, "realm":..., "domain":...,
 *     "savedAtMs":..., "payload":... }
 *
 * `savedAtMs` is METADATA ONLY. It is never used to decide which file is
 * authoritative and there is never a "newest file wins" recovery. `readEnvelope`
 * validates format/version/realm/domain and returns a tri-state `LoadResult`.
 * Writes are atomic (temp + rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoadResult, StateDomain, StateRealm } from './types.js';

export const STATE_FORMAT = 'retrac-state';
export const STATE_VERSION = 1;

export interface StateEnvelope<T = unknown> {
  format: typeof STATE_FORMAT;
  version: number;
  realm: StateRealm;
  domain: StateDomain;
  savedAtMs: number;
  payload: T;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Read + validate a state envelope from `filePath` against the expected realm and
 * domain. Returns the envelope (payload as `unknown`) on OK.
 *
 * A leftover `.tmp` sibling is treated as CORRUPT (an interrupted write).
 */
export function readEnvelope(
  filePath: string,
  expectedRealm: StateRealm,
  expectedDomain: StateDomain,
): LoadResult<StateEnvelope> {
  if (existsSync(`${filePath}.tmp`)) {
    return {
      status: 'CORRUPT',
      reason: `leftover .tmp file (${filePath}.tmp) indicates an interrupted write; refusing to read mid-write state`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return { status: 'MISSING' };
    return { status: 'CORRUPT', reason: `could not read state file: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (raw.trim() === '') {
    return { status: 'CORRUPT', reason: 'state file is empty or whitespace-only' };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: 'CORRUPT', reason: 'state file is not valid JSON' };
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { status: 'CORRUPT', reason: 'state file is not an envelope object' };
  }

  const env = json as Record<string, unknown>;
  if (env.format !== STATE_FORMAT) {
    return { status: 'CORRUPT', reason: `missing/unknown envelope format (expected "${STATE_FORMAT}")` };
  }
  if (env.version !== STATE_VERSION) {
    return { status: 'CORRUPT', reason: `unsupported state version ${String(env.version)} (expected ${STATE_VERSION})` };
  }
  if (env.realm !== expectedRealm) {
    return {
      status: 'CORRUPT',
      reason: `state realm mismatch: expected "${expectedRealm}" but file declares "${String(env.realm)}"`,
    };
  }
  if (env.domain !== expectedDomain) {
    return {
      status: 'CORRUPT',
      reason: `state domain mismatch: expected "${expectedDomain}" but file declares "${String(env.domain)}"`,
    };
  }
  if (typeof env.savedAtMs !== 'number' || !Number.isFinite(env.savedAtMs) || env.savedAtMs < 0) {
    return { status: 'CORRUPT', reason: 'state file has an invalid savedAtMs' };
  }
  if (!('payload' in env) || env.payload === undefined) {
    return { status: 'CORRUPT', reason: 'state envelope is missing its payload' };
  }

  return { status: 'OK', data: env as unknown as StateEnvelope };
}

/**
 * Atomically write a state envelope (temp + rename). The target is never replaced
 * by a partial document.
 */
export function writeEnvelope(filePath: string, realm: StateRealm, domain: StateDomain, payload: unknown): void {
  const env: StateEnvelope = {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    realm,
    domain,
    savedAtMs: Date.now(),
    payload,
  };
  const tmp = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(env, null, 2));
  renameSync(tmp, filePath);
}
