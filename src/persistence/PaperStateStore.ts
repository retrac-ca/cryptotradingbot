/**
 * PaperStateStore — the durable store for the PAPER portfolio.
 *
 * This is the PAPER realm (realm=`paper`, domain=`portfolio`). It persists the
 * simulated portfolio (cash, positions, ownership, reservations, applied
 * executions, manual settlements, P&L, fees, peak equity) plus the paper
 * executed order ids.
 *
 * Fail-closed loading: `load()` returns a tri-state `LoadResult` so a CORRUPT
 * file is NEVER treated as MISSING (which would silently reset the paper
 * account). `save()` writes a versioned envelope atomically, inside the
 * state-directory mutation lock.
 */

import { dirname } from 'node:path';
import {
  serializePortfolio,
  deserializePortfolio,
  type PortfolioJson,
} from '../portfolio/serialization.js';
import type { PortfolioModel } from '../portfolio/types.js';
import { readEnvelope, writeEnvelope } from './envelope.js';
import { withStateDirLock } from './lock.js';
import type { LoadResult } from './types.js';

/** The payload of a paper-state file: the portfolio JSON + paper-only ids. */
export type PaperStatePayload = PortfolioJson & {
  executedOrderIds: string[];
};

export class PaperStateStore {
  constructor(private readonly filePath: string) {}

  /** Tri-state load (OK / MISSING / CORRUPT). CORRUPT is never MISSING. */
  load(): LoadResult<PaperStatePayload> {
    const r = readEnvelope(this.filePath, 'paper', 'portfolio');
    if (r.status !== 'OK') return r;
    const payload = r.data.payload as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'CORRUPT', reason: 'paper state payload is not an object' };
    }
    const p = payload as Record<string, unknown>;
    if (!Array.isArray(p.executedOrderIds)) {
      return { status: 'CORRUPT', reason: 'paper state is missing its executedOrderIds' };
    }
    // Validate the portfolio part (conservation, Money, source, reservations).
    try {
      deserializePortfolio(p as unknown as PortfolioJson, { realm: 'paper' });
    } catch (err) {
      return { status: 'CORRUPT', reason: `invalid paper portfolio: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { status: 'OK', data: payload as PaperStatePayload };
  }

  /** Recover a PortfolioModel from a validated payload, or null. */
  toPortfolio(payload: PaperStatePayload | null): PortfolioModel | null {
    if (!payload) return null;
    try {
      return deserializePortfolio(payload, { realm: 'paper' });
    } catch {
      return null;
    }
  }

  /** Persist the paper portfolio + executed ids (atomic, inside the lock). */
  save(portfolio: PortfolioModel, executedOrderIds: string[]): void {
    const payload: PaperStatePayload = {
      ...serializePortfolio(portfolio),
      executedOrderIds,
    };
    withStateDirLock(dirname(this.filePath), () => {
      writeEnvelope(this.filePath, 'paper', 'portfolio', payload);
    });
  }
}
