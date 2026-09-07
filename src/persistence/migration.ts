/**
 * Legacy state migration (Persistence & Restart Recovery).
 *
 * Migrates a legacy top-level state file (the pre-`stateDir` default names) into
 * the new versioned envelope under `stateDir` — once, conservatively, without
 * discarding the original. If the legacy file is corrupt, migration HALTS
 * (operator intervention) rather than silently dropping or overwriting it.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { deserializePortfolio, type PortfolioJson } from '../portfolio/serialization.js';
import { writeEnvelope } from './envelope.js';
import { withStateDirLock } from './lock.js';
import { CorruptStateError } from './types.js';
import type { StateDomain, StateRealm } from './types.js';
import type { BotConfig } from '../config/schema.js';

const LEGACY_PATHS = {
  paper: '.paper-state.json',
  live: '.live-managed-state.json',
  order: '.order-ledger.json',
  manual: '.manual-intents.json',
} as const;

/**
 * Migrate legacy state files to the envelope format under the configured paths.
 * No-op when the new file already exists or no legacy file exists. Runs inside
 * the state-directory mutation lock. Throws (HALT) on a corrupt legacy file.
 *
 * `baseDir` (default `process.cwd()`) is where the legacy top-level files are
 * looked for; it defaults to the process cwd and is configurable for tests.
 */
export function migrateLegacyState(cfg: BotConfig, baseDir: string = process.cwd()): void {
  withStateDirLock(cfg.stateDir, () => {
    migrateOne(join(baseDir, LEGACY_PATHS.paper), cfg.paperStateFile, 'paper', 'portfolio', (raw) => {
      const json = JSON.parse(raw) as PortfolioJson & { executedOrderIds?: unknown };
      deserializePortfolio(json, { realm: 'paper' }); // validate ownership/conservation
      return {
        ...json,
        executedOrderIds: Array.isArray(json.executedOrderIds) ? json.executedOrderIds : [],
      };
    });

    migrateOne(join(baseDir, LEGACY_PATHS.live), cfg.liveManagedStateFile, 'live', 'portfolio', (raw) => {
      const json = JSON.parse(raw) as PortfolioJson;
      deserializePortfolio(json, { realm: 'live' });
      return json;
    });

    migrateOne(join(baseDir, LEGACY_PATHS.order), cfg.orderLedgerFile, 'live', 'order-ledger', (raw) => {
      const json = JSON.parse(raw) as { orders?: unknown };
      if (!json.orders || typeof json.orders !== 'object' || Array.isArray(json.orders)) {
        throw new Error('legacy order ledger is missing its orders map');
      }
      return { orders: json.orders as Record<string, unknown> };
    });

    migrateOne(join(baseDir, LEGACY_PATHS.manual), cfg.manualIntentFile, 'live', 'manual-intents', (raw) => {
      const json = JSON.parse(raw) as { version?: unknown; intents?: unknown; savedAtMs?: unknown };
      if (json.version !== 1 && json.version !== 2) {
        throw new Error(`legacy manual intent store has unsupported version ${String(json.version)}`);
      }
      if (!json.intents || typeof json.intents !== 'object' || Array.isArray(json.intents)) {
        throw new Error('legacy manual intent store is missing its intents map');
      }
      return {
        version: json.version,
        intents: json.intents as Record<string, unknown>,
        savedAtMs: typeof json.savedAtMs === 'number' ? json.savedAtMs : 0,
      };
    });
  });
}

function migrateOne(
  legacyPath: string,
  newPath: string,
  realm: StateRealm,
  domain: StateDomain,
  transform: (raw: string) => unknown,
): void {
  if (existsSync(newPath)) return; // already migrated
  if (!existsSync(legacyPath)) return;

  let payload: unknown;
  try {
    payload = transform(readFileSync(legacyPath, 'utf8'));
  } catch (err) {
    throw new CorruptStateError(
      `legacy ${domain} state is corrupt (${legacyPath}): ${err instanceof Error ? err.message : String(err)}; ` +
        'not migrating — operator must reconcile before the bot will start',
    );
  }

  writeEnvelope(newPath, realm, domain, payload);
  // Preserve the original (do not silently delete it); a later migration is a no-op.
  try {
    renameSync(legacyPath, `${legacyPath}.legacy`);
  } catch {
    /* ignore: if rename fails the original stays put, and the new file is authoritative */
  }
}
