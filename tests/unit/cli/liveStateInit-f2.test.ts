/**
 * F-2 — live/manual managed-state initialization vs state-loss detection.
 *
 * The PAPER path already distinguishes a genuine first-ever run from unexpected
 * state loss using the StateInitMarker. These tests verify the live realm
 * mirrors that fail-closed behavior: a deleted live-managed state file after
 * the realm was initialized must NOT be silently re-seeded as empty.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  ManagedStateStore,
  StateInitMarker,
  withStateDirLock,
  CorruptStateError,
} from '../../../src/persistence/index.js';
import { loadLiveManagedPortfolio } from '../../../src/cli/live-test-cmd.js';
import type { BotConfig } from '../../../src/config/schema.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'retrac-f2-'));
}

function cfg(d: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    stateDir: d,
    liveManagedStateFile: join(d, 'live-state.json'),
    paperStateFile: join(d, 'paper-state.json'),
    orderLedgerFile: join(d, 'ledger.json'),
    manualIntentFile: join(d, 'intents.json'),
    ...over,
  } as BotConfig;
}

describe('F-2 — live managed state first-run vs state loss', () => {
  it('genuine first run: missing state + missing marker => empty portfolio, realm initialized', () => {
    const d = dir();
    const c = cfg(d);
    const p = loadLiveManagedPortfolio(c);
    expect(p.managedOpenCount()).toBe(0);
    expect(p.deployableQuote('CAD').isZero()).toBe(true);

    // The realm is now initialized and the empty state was persisted, so a later
    // disappearance is detectable as state loss.
    const marker = new StateInitMarker(join(d, '.init.json'));
    expect(marker.isInitialized('live')).toBe(true);

    // A second load now sees OK state, not a fresh first run.
    const p2 = loadLiveManagedPortfolio(c);
    expect(p2.managedOpenCount()).toBe(0);
  });

  it('previously initialized: state + marker exist => normal load', () => {
    const d = dir();
    const c = cfg(d);
    // First run creates both the state file and the marker.
    loadLiveManagedPortfolio(c);

    // Persist a real managed position.
    const store = new ManagedStateStore(c.liveManagedStateFile);
    const withPos = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    store.save(withPos.stateModel);

    const p = loadLiveManagedPortfolio(c);
    expect(p.position('BTC/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
  });

  it('state loss after initialization: state missing but marker initialized => FAIL CLOSED', () => {
    const d = dir();
    const c = cfg(d);
    // First run creates both the state file and the marker.
    loadLiveManagedPortfolio(c);

    // Simulate unexpected state loss: the managed-state file disappears.
    rmSync(c.liveManagedStateFile, { force: true });

    expect(() => loadLiveManagedPortfolio(c)).toThrow(CorruptStateError);
  });

  it('corrupt state after initialization => FAIL CLOSED (never empty)', () => {
    const d = dir();
    const c = cfg(d);
    writeFileSync(c.liveManagedStateFile, '{ not json');
    withStateDirLock(d, () => new StateInitMarker(join(d, '.init.json')).markInitialized('live'));

    expect(() => loadLiveManagedPortfolio(c)).toThrow(CorruptStateError);
  });

  it('corrupt state => FAIL CLOSED even when the realm was never initialized', () => {
    const d = dir();
    const c = cfg(d);
    writeFileSync(c.liveManagedStateFile, '{ not json');

    expect(() => loadLiveManagedPortfolio(c)).toThrow(CorruptStateError);
  });
});
