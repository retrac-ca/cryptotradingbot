/**
 * ManagedStateStore — the durable store for the bot's LIVE managed portfolio.
 *
 * This is ARCHITECTURALLY SEPARATE from `PaperStateStore` (realm=`live`,
 * domain=`portfolio`). It holds the inventory the bot is authorized to manage on
 * the REAL exchange. It reuses the Portfolio serialization format but keeps its
 * own file, its own envelope realm, and its own store instance.
 *
 * Fail-closed loading: a CORRUPT live-managed file is NEVER interpreted as "no
 * managed inventory" (that would hide loss of the local accounting state). It
 * returns CORRUPT -> the caller HALTs. MISSING is only a legitimate first-ever
 * (pre-initialization) state.
 */

import { dirname } from 'node:path';
import {
  serializePortfolio,
  deserializePortfolio,
  type PortfolioJson,
} from '../portfolio/serialization.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type { PortfolioModel } from '../portfolio/types.js';
import { readEnvelope, writeEnvelope } from './envelope.js';
import { withStateDirLock } from './lock.js';
import type { LoadResult } from './types.js';

export type ManagedStatePayload = PortfolioJson;

export class ManagedStateStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  /** Tri-state load (OK / MISSING / CORRUPT). CORRUPT is never MISSING. */
  load(): LoadResult<ManagedStatePayload> {
    const r = readEnvelope(this.filePath, 'live', 'portfolio');
    if (r.status !== 'OK') return r;
    const payload = r.data.payload as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'CORRUPT', reason: 'live managed state payload is not an object' };
    }
    try {
      deserializePortfolio(payload as PortfolioJson, { realm: 'live' });
    } catch (err) {
      return { status: 'CORRUPT', reason: `invalid live managed portfolio: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { status: 'OK', data: payload as ManagedStatePayload };
  }

  /** Recover a live managed `Portfolio` from a validated payload, or null. */
  toPortfolio(payload: ManagedStatePayload | null): Portfolio | null {
    if (!payload) return null;
    try {
      return Portfolio.fromModel(deserializePortfolio(payload, { realm: 'live' }));
    } catch {
      return null;
    }
  }

  /** Persist the live managed portfolio (atomic, inside the lock). */
  save(portfolio: PortfolioModel): void {
    const payload = serializePortfolio(portfolio);
    withStateDirLock(dirname(this.filePath), () => {
      writeEnvelope(this.filePath, 'live', 'portfolio', payload);
    });
  }
}
