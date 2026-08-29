/**
 * Minimal paper-state store — persists enough to make a restart safe.
 *
 * Phase 9 will build a fuller persistence layer (SQLite, order/trade history,
 * reconciliations). For Phase 8 we only need what the continuously-running
 * paper bot requires to avoid incorrectly resetting its portfolio across a
 * restart:
 *   - the portfolio (cash, positions, P&L, fees, peak equity), and
 *   - the set of previously executed paper order client ids (for idempotency).
 *
 * The store is a single JSON file. Writes are atomic (write temp + rename).
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  serializePortfolio,
  deserializePortfolio,
  type PortfolioJsonV1,
} from '../portfolio/serialization.js';
import type { PortfolioModel } from '../portfolio/types.js';

export interface PaperStateFileV1 extends PortfolioJsonV1 {
  executedOrderIds: string[];
  savedAtMs: number;
}

export class PaperStateStore {
  constructor(private readonly filePath: string) {}

  /** Load state, or null if none exists yet / unreadable. */
  load(): PaperStateFileV1 | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const json = JSON.parse(raw) as PaperStateFileV1;
      if (json.version !== 1) return null;
      return {
        ...json,
        executedOrderIds: Array.isArray(json.executedOrderIds) ? json.executedOrderIds : [],
      };
    } catch {
      return null;
    }
  }

  save(portfolio: PortfolioModel, executedOrderIds: string[]): void {
    const json: PaperStateFileV1 = {
      ...serializePortfolio(portfolio),
      executedOrderIds,
      savedAtMs: Date.now(),
    };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(json, null, 2));
    renameSync(tmp, this.filePath);
  }

  /** Recover a PortfolioModel from a persisted state, or null. */
  toPortfolio(file: PaperStateFileV1 | null): PortfolioModel | null {
    if (!file) return null;
    try {
      return deserializePortfolio(file);
    } catch {
      return null;
    }
  }
}
