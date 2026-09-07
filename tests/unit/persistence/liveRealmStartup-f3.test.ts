/**
 * F-3 — production startup cross-file consistency validation.
 *
 * The existing `recoverState` coordinator validates cross-file consistency but
 * was only exercised by tests. These tests verify the production startup gate
 * (`assertLiveRealmRecoverable`) accepts a consistent set of durable files and
 * fails closed on cross-file contradictions (orphan reservation, ACCOUNTED
 * manual intent without a settlement).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { ManualIntentStore } from '../../../src/manual/index.js';
import { assertLiveRealmRecoverable } from '../../../src/cli/live-test-cmd.js';
import type { BotConfig } from '../../../src/config/schema.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'retrac-f3-'));
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

const validIntent = {
  intentId: 'manual-i1',
  status: 'PROPOSED' as const,
  symbol: 'BTC/CAD',
  side: 'BUY' as const,
  type: 'market' as const,
  quantity: '0.12500000',
  limitPrice: null,
  tif: null,
  reason: 'test',
  riskSnapshot: {
    symbol: 'BTC/CAD', side: 'BUY', type: 'market', referencePrice: '40000.00000000',
    estimatedNotional: '5000.00000000', estimatedFee: '10.00000000', quoteCurrency: 'CAD',
    requiredBalance: '5010.00000000', deployableQuoteAtProposal: '100000.00000000',
    portfolioValueAtProposal: '50000.00000000', peakPortfolioValueAtProposal: '50000.00000000',
    portfolioExposureAtProposal: '0.00000000', currentPositionAtProposal: '0.00000000',
    openManagedPositionCountAtProposal: 0, appliedLimits: {},
    marketDataTimestampMs: 1, marketDataObservedAtMs: 1, proposalTimeMs: 1,
  },
  evidence: null,
  operatorConfirmedBy: null,
  createdAtMs: 1,
  updatedAtMs: 1,
  events: [],
  reservationCurrency: 'CAD',
  reservationAmount: '5010.00000000',
};

describe('F-3 — production startup cross-file consistency', () => {
  it('accepts a consistent set of durable files', () => {
    const d = dir();
    const c = cfg(d);
    // Fresh directory with no state at all => consistent (genuine first run).
    expect(() => assertLiveRealmRecoverable(c)).not.toThrow();
  });

  it('accepts a consistent initialized live realm with a settlement', () => {
    const d = dir();
    const c = cfg(d);
    // Initialize the live realm.
    withStateDirLock(d, () => new StateInitMarker(join(d, '.init.json')).markInitialized('live'));
    // A live managed state with no orphan reservations and no accounted intents.
    new ManagedStateStore(c.liveManagedStateFile).save(
      Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])).stateModel,
    );
    expect(() => assertLiveRealmRecoverable(c)).not.toThrow();
  });

  it('rejects an orphan reservation with no corresponding order or intent', () => {
    const d = dir();
    const c = cfg(d);
    withStateDirLock(d, () => new StateInitMarker(join(d, '.init.json')).markInitialized('live'));
    new ManagedStateStore(c.liveManagedStateFile).save(
      Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
        .reserveOrder('orphan', 'CAD', Money.fromString('500'))
        .stateModel,
    );
    expect(() => assertLiveRealmRecoverable(c)).toThrow(/reservation for orphan has no corresponding order or manual intent/);
  });

  it('rejects an ACCOUNTED manual intent without a portfolio settlement', () => {
    const d = dir();
    const c = cfg(d);
    withStateDirLock(d, () => new StateInitMarker(join(d, '.init.json')).markInitialized('live'));
    // An empty live portfolio (no settlement) but an ACCOUNTED intent.
    new ManagedStateStore(c.liveManagedStateFile).save(
      Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])).stateModel,
    );
    new ManualIntentStore(c.manualIntentFile).save({
      ...validIntent,
      status: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION',
    } as never);
    expect(() => assertLiveRealmRecoverable(c)).toThrow(/accounted manual intent manual-i1 has no portfolio settlement/);
  });

  it('accepts a manual reservation tied to a valid intent (no false positive)', () => {
    const d = dir();
    const c = cfg(d);
    withStateDirLock(d, () => new StateInitMarker(join(d, '.init.json')).markInitialized('live'));
    // A BUY manual reservation is keyed by the intent id; the intent exists.
    new ManagedStateStore(c.liveManagedStateFile).save(
      Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
        .reserveOrder('manual-i1', 'CAD', Money.fromString('500'))
        .stateModel,
    );
    new ManualIntentStore(c.manualIntentFile).save(validIntent as never);
    // The intent is non-terminal (PROPOSED) => RECONCILIATION_REQUIRED, but that
    // is NOT a cross-file contradiction, so the startup gate must not block.
    expect(() => assertLiveRealmRecoverable(c)).not.toThrow();
  });

  it('rejects a corrupt live managed state (HALTED)', () => {
    const d = dir();
    const c = cfg(d);
    writeFileSync(c.liveManagedStateFile, '{ not json');
    expect(() => assertLiveRealmRecoverable(c)).toThrow(CorruptStateError);
  });
});
