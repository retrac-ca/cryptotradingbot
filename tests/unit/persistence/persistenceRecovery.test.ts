/**
 * Persistence & Restart Recovery — envelope, tri-state load, lock, init marker,
 * and recovery-coordinator tests.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio } from '../../../src/portfolio/serialization.js';
import {
  PaperStateStore,
  ManagedStateStore,
  OrderStore,
  StateInitMarker,
  withStateDirLock,
  readEnvelope,
  writeEnvelope,
  recoverState,
  migrateLegacyState,
  StateLockedError,
  CorruptStateError,
} from '../../../src/persistence/index.js';
import { ManualIntentStore, CorruptManualIntentStoreError } from '../../../src/manual/ManualIntentStore.js';
import type { RecoveryInputs } from '../../../src/persistence/index.js';
import type { Order } from '../../../src/order.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `retrac-${prefix}-`));
}

function validPortfolioPayload(): Record<string, unknown> {
  const cash = new Map<string, Money>([['CAD', Money.fromString('10000')]]);
  return { ...serializePortfolio(Portfolio.empty(cash).stateModel), executedOrderIds: [] };
}

function sampleOrder(clientOrderId: string, status: Order['status']): Order {
  const now = Date.now();
  return {
    clientOrderId,
    exchangeOrderId: status === 'CREATED' ? null : 'e1',
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    status,
    quantity: Money.fromString('0.1'),
    filledQuantity: Money.zero(),
    averagePrice: null,
    price: null,
    fills: [],
    fee: Money.zero(),
    feeCurrency: 'quote',
    reason: 'test',
    createdAtMs: now,
    updatedAtMs: now,
  };
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

describe('Persistence — envelope & tri-state load', () => {
  it('MISSING only for ENOENT', () => {
    const f = join(tmpDir('env'), 'x.json');
    const r = readEnvelope(f, 'paper', 'portfolio');
    expect(r.status).toBe('MISSING');
  });

  it('zero-byte file is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeFileSync(f, '');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('whitespace-only file is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeFileSync(f, '   \n  ');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('JSON null is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeFileSync(f, 'null');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('JSON {} is CORRUPT (missing envelope)', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeFileSync(f, '{}');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('malformed JSON is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeFileSync(f, '{ not json');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('unsupported version is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeEnvelope(f, 'paper', 'portfolio', {});
    writeFileSync(f, JSON.stringify({ format: 'retrac-state', version: 99, realm: 'paper', domain: 'portfolio', savedAtMs: 1, payload: {} }));
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('realm mismatch is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeEnvelope(f, 'live', 'portfolio', {});
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('domain mismatch is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeEnvelope(f, 'paper', 'order-ledger', {});
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('a leftover .tmp file is CORRUPT', () => {
    const f = join(tmpDir('env'), 'x.json');
    writeEnvelope(f, 'paper', 'portfolio', {});
    writeFileSync(`${f}.tmp`, '{}');
    expect(readEnvelope(f, 'paper', 'portfolio').status).toBe('CORRUPT');
  });

  it('invalid portfolio payload (bad Money) is CORRUPT via the store', () => {
    const f = join(tmpDir('env'), 'paper.json');
    writeEnvelope(f, 'paper', 'portfolio', { ...validPortfolioPayload(), cash: { CAD: 'garbage' } });
    expect(new PaperStateStore(f).load().status).toBe('CORRUPT');
  });

  it('invalid conservation is CORRUPT via the store', () => {
    const f = join(tmpDir('env'), 'paper.json');
    const payload = serializePortfolio(Portfolio.empty(new Map([['CAD', Money.fromString('100')]])).stateModel);
    // Break conservation by setting a position's sourceQuantities to not sum to quantity.
    const broken = {
      ...payload,
      positions: {
        'BTC/CAD': {
          symbol: 'BTC/CAD', quantity: '0.35', averageEntryPrice: '100', costBasis: '35',
          realizedPnl: '0', feesPaid: '0', source: 'BOT',
          sourceQuantities: { BOT: '0.1', EXTERNAL_AUTHORIZED: '0.1' },
        },
      },
      executedOrderIds: [],
    };
    writeEnvelope(f, 'paper', 'portfolio', broken);
    expect(new PaperStateStore(f).load().status).toBe('CORRUPT');
  });
});

describe('Persistence — corruption safety (no silent reset)', () => {
  it('corrupt paper state is CORRUPT, never MISSING', () => {
    const f = join(tmpDir('corrupt'), 'paper.json');
    writeFileSync(f, '{ not json');
    const store = new PaperStateStore(f);
    expect(store.load().status).toBe('CORRUPT');
  });

  it('corrupt order ledger is CORRUPT and save() refuses to overwrite', () => {
    const f = join(tmpDir('corrupt'), 'ledger.json');
    writeFileSync(f, '{ not json');
    const store = new OrderStore(f);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.save(sampleOrder('a', 'CREATED'))).toThrow(/refusing to overwrite/);
  });

  it('corrupt live managed state is CORRUPT, never empty', () => {
    const f = join(tmpDir('corrupt'), 'live.json');
    writeFileSync(f, '{ not json');
    expect(new ManagedStateStore(f).load().status).toBe('CORRUPT');
  });

  it('corrupt manual intents is CORRUPT and never resets to empty', () => {
    const f = join(tmpDir('corrupt'), 'intents.json');
    writeFileSync(f, '{ not json');
    const store = new ManualIntentStore(f);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(CorruptManualIntentStoreError);
  });
});

describe('Persistence — mutation lock', () => {
  it('acquires and releases around a transaction; a nested same-dir lock is reentrant', () => {
    const dir = tmpDir('lock');
    const results: string[] = [];
    withStateDirLock(dir, () => {
      results.push('first');
      // Nested same-directory lock within this process is REENTRANT (needed for
      // commitProven calling store.save() inside a transaction).
      withStateDirLock(dir, () => results.push('nested'));
    });
    expect(results).toEqual(['first', 'nested']);
    // Lock released: a subsequent acquire succeeds.
    withStateDirLock(dir, () => results.push('after'));
    expect(results).toEqual(['first', 'nested', 'after']);
  });

  it('an existing lock refuses without auto-stealing (no stale detection)', () => {
    const dir = tmpDir('lock');
    // Simulate a lock left by another process.
    writeFileSync(join(dir, '.mutation.lock'), JSON.stringify({ pid: 999999, createdAtMs: 1 }));
    expect(() => withStateDirLock(dir, () => undefined)).toThrow(StateLockedError);
  });

  it('a malformed lock file refuses', () => {
    const dir = tmpDir('lock');
    writeFileSync(join(dir, '.mutation.lock'), 'garbage');
    expect(() => withStateDirLock(dir, () => undefined)).toThrow(StateLockedError);
  });
});

describe('Persistence — initialization marker', () => {
  it('a missing marker is MISSING and isInitialized is false', () => {
    const marker = new StateInitMarker(join(tmpDir('init'), '.init.json'));
    expect(marker.load().status).toBe('MISSING');
    expect(marker.isInitialized('paper')).toBe(false);
  });

  it('markInitialized writes a durable marker and is idempotent', () => {
    const marker = new StateInitMarker(join(tmpDir('init'), '.init.json'));
    marker.markInitialized('paper');
    expect(marker.isInitialized('paper')).toBe(true);
    expect(marker.isInitialized('live')).toBe(false);
    marker.markInitialized('paper');
    expect(marker.isInitialized('paper')).toBe(true);
    // Preserves other realm flag.
    marker.markInitialized('live');
    expect(marker.isInitialized('live')).toBe(true);
  });

  it('a corrupt marker is CORRUPT and isInitialized throws (never assume not-initialized)', () => {
    const f = join(tmpDir('init'), '.init.json');
    writeFileSync(f, '{ not json');
    const marker = new StateInitMarker(f);
    expect(marker.load().status).toBe('CORRUPT');
    expect(() => marker.isInitialized('paper')).toThrow(CorruptStateError);
    expect(() => marker.markInitialized('paper')).toThrow(CorruptStateError);
  });
});

describe('Persistence — recovery coordinator', () => {
  function makeInputs(dir: string): { inputs: RecoveryInputs; paperFile: string; liveFile: string; ledgerFile: string; intentFile: string; initFile: string } {
    const paperFile = join(dir, 'paper.json');
    const liveFile = join(dir, 'live.json');
    const ledgerFile = join(dir, 'ledger.json');
    const intentFile = join(dir, 'intents.json');
    const initFile = join(dir, '.init.json');
    const inputs: RecoveryInputs = {
      paper: new PaperStateStore(paperFile),
      live: new ManagedStateStore(liveFile),
      orders: new OrderStore(ledgerFile),
      manualIntents: new ManualIntentStore(intentFile),
      initMarker: new StateInitMarker(initFile),
    };
    return { inputs, paperFile, liveFile, ledgerFile, intentFile, initFile };
  }

  it('clean present state -> READY', () => {
    const { inputs, paperFile, initFile } = makeInputs(tmpDir('rec'));
    const store = new PaperStateStore(paperFile);
    store.save(Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])).stateModel, []);
    const init = new StateInitMarker(initFile);
    init.markInitialized('paper');
    const r = recoverState({ ...inputs, paper: store, initMarker: init });
    expect(r.status).toBe('READY');
    expect(r.requiresExchangeRead).toBe(false);
  });

  it('corrupt paper state -> HALTED', () => {
    const { inputs, paperFile } = makeInputs(tmpDir('rec'));
    writeFileSync(paperFile, '{ not json');
    const r = recoverState({ ...inputs, paper: new PaperStateStore(paperFile) });
    expect(r.status).toBe('HALTED');
    expect(r.reasons.some((x) => /corrupt/i.test(x))).toBe(true);
  });

  it('paper MISSING but initialized -> HALTED (unexpected state loss, never re-seed)', () => {
    const { inputs, initFile } = makeInputs(tmpDir('rec'));
    const init = new StateInitMarker(initFile);
    init.markInitialized('paper');
    const r = recoverState({ ...inputs, initMarker: init });
    expect(r.status).toBe('HALTED');
    expect(r.reasons.some((x) => /missing.*initialized/i.test(x))).toBe(true);
  });

  it('an unresolved (non-terminal) order -> RECONCILIATION_REQUIRED', () => {
    const { inputs, ledgerFile } = makeInputs(tmpDir('rec'));
    const store = new OrderStore(ledgerFile);
    store.save(sampleOrder('o1', 'UNKNOWN'));
    const r = recoverState({ ...inputs, orders: store });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(r.unresolvedOrders).toEqual(['o1']);
    expect(r.requiresExchangeRead).toBe(true);
  });

  it('an unresolved manual intent -> RECONCILIATION_REQUIRED', () => {
    const { inputs, intentFile } = makeInputs(tmpDir('rec'));
    const store = new ManualIntentStore(intentFile);
    store.save({ ...validIntent } as never);
    const r = recoverState({ ...inputs, manualIntents: store });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(r.unresolvedIntents).toContain('manual-i1');
  });

  it('an orphan reservation -> RECONCILIATION_REQUIRED (never released)', () => {
    const { inputs, liveFile } = makeInputs(tmpDir('rec'));
    const store = new ManagedStateStore(liveFile);
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
      .reserveOrder('ord-orphan', 'CAD', Money.fromString('500'));
    store.save(p.stateModel);
    const r = recoverState({ ...inputs, live: store });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(r.unresolvedReservations).toContain('ord-orphan');
  });

  it('an ACCOUNTED manual intent without a portfolio settlement -> RECONCILIATION_REQUIRED', () => {
    const { inputs, liveFile, intentFile } = makeInputs(tmpDir('rec'));
    const live = new ManagedStateStore(liveFile);
    live.save(Portfolio.empty(new Map([['CAD', Money.fromString('10000')]])).stateModel);
    const intents = new ManualIntentStore(intentFile);
    intents.save({ ...validIntent, status: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION' } as never);
    const r = recoverState({ ...inputs, live, manualIntents: intents });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(r.unresolvedIntents).toContain('manual-i1');
  });
});

describe('Persistence — PAPER/LIVE isolation', () => {
  it('a paper store rejects a live-realm envelope', () => {
    const f = join(tmpDir('iso'), 'x.json');
    writeEnvelope(f, 'live', 'portfolio', validPortfolioPayload());
    expect(new PaperStateStore(f).load().status).toBe('CORRUPT');
  });

  it('a live store rejects a paper-realm envelope', () => {
    const f = join(tmpDir('iso'), 'x.json');
    writeEnvelope(f, 'paper', 'portfolio', serializePortfolio(Portfolio.empty(new Map([['CAD', Money.fromString('100')]])).stateModel));
    expect(new ManagedStateStore(f).load().status).toBe('CORRUPT');
  });
});

describe('Persistence — legacy migration', () => {
  it('migrates a legacy top-level paper file into the envelope under stateDir', () => {
    const base = tmpDir('mig');
    const stateDir = join(base, '.state');
    const paperFile = join(stateDir, 'paper-state.json');
    // Legacy top-level file (no envelope) in baseDir.
    const legacy = join(base, '.paper-state.json');
    writeFileSync(legacy, JSON.stringify({ ...serializePortfolio(Portfolio.empty(new Map([['CAD', Money.fromString('5000')]])).stateModel), executedOrderIds: ['p1'] }));
    const cfg = {
      stateDir,
      paperStateFile: paperFile,
      liveManagedStateFile: join(stateDir, 'live.json'),
      orderLedgerFile: join(stateDir, 'ledger.json'),
      manualIntentFile: join(stateDir, 'intents.json'),
    } as never;

    migrateLegacyState(cfg, base);

    const r = new PaperStateStore(paperFile).load();
    expect(r.status).toBe('OK');
    if (r.status === 'OK') {
      expect(r.data.executedOrderIds).toEqual(['p1']);
      expect(r.data.cash['CAD']).toBe('5000.00000000');
    }
    // Original preserved (renamed to .legacy).
    expect(existsSync(`${legacy}.legacy`)).toBe(true);
  });

  it('a corrupt legacy file HALTs migration (never silently discarded)', () => {
    const base = tmpDir('mig');
    const stateDir = join(base, '.state');
    const legacy = join(base, '.paper-state.json');
    writeFileSync(legacy, '{ not json');
    const cfg = {
      stateDir,
      paperStateFile: join(stateDir, 'paper-state.json'),
      liveManagedStateFile: join(stateDir, 'live.json'),
      orderLedgerFile: join(stateDir, 'ledger.json'),
      manualIntentFile: join(stateDir, 'intents.json'),
    } as never;
    expect(() => migrateLegacyState(cfg, base)).toThrow(CorruptStateError);
  });
});
