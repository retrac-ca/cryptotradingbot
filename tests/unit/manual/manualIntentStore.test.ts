/**
 * Gate 9 — ManualIntentStore durability / fail-closed loading (envelope format).
 *
 * A corrupted manual-intent store must NEVER silently read as "there are no
 * intents": it can hide active reservations or unresolved executions. Only a
 * genuinely absent file (fresh state) returns an empty view. `load()` returns a
 * tri-state LoadResult; the bridge-facing methods (`allIntents`/`get`/`save`)
 * throw CorruptManualIntentStoreError on corruption (fail closed).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualIntentStore, CorruptManualIntentStoreError } from '../../../src/manual/index.js';

function freshDir(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `retrac-mi-${name}-`));
  return join(d, 'intents.json');
}

function fresh(name: string): ManualIntentStore {
  const p = freshDir(name);
  rmSync(p, { force: true });
  rmSync(`${p}.tmp`, { force: true });
  return new ManualIntentStore(p);
}

function writeRaw(name: string, content: string): ManualIntentStore {
  const p = freshDir(name);
  rmSync(p, { force: true });
  rmSync(`${p}.tmp`, { force: true });
  writeFileSync(p, content);
  return new ManualIntentStore(p);
}

const validIntent = {
  intentId: 'manual-i1',
  status: 'PROPOSED',
  symbol: 'BTC/CAD',
  side: 'BUY',
  type: 'market',
  quantity: '0.12500000',
  limitPrice: null,
  tif: null,
  reason: 'test',
  riskSnapshot: {
    symbol: 'BTC/CAD',
    side: 'BUY',
    type: 'market',
    referencePrice: '40000.00000000',
    estimatedNotional: '5000.00000000',
    estimatedFee: '10.00000000',
    quoteCurrency: 'CAD',
    requiredBalance: '5010.00000000',
    deployableQuoteAtProposal: '100000.00000000',
    portfolioValueAtProposal: '50000.00000000',
    peakPortfolioValueAtProposal: '50000.00000000',
    portfolioExposureAtProposal: '0.00000000',
    currentPositionAtProposal: '0.00000000',
    openManagedPositionCountAtProposal: 0,
    appliedLimits: {},
    marketDataTimestampMs: 1_000_000_000,
    marketDataObservedAtMs: 1_000_000_000,
    proposalTimeMs: 1_000_000_000,
  },
  evidence: null,
  operatorConfirmedBy: null,
  createdAtMs: 1_000_000_000,
  updatedAtMs: 1_000_000_000,
  events: [],
  reservationCurrency: 'CAD',
  reservationAmount: '5010.00000000',
};

function envelope(payload: unknown): string {
  return JSON.stringify({
    format: 'retrac-state',
    version: 1,
    realm: 'live',
    domain: 'manual-intents',
    savedAtMs: 1_000_000_000,
    payload,
  });
}

function validPayload(): Record<string, unknown> {
  return { version: 2, intents: { 'manual-i1': validIntent }, savedAtMs: 1_000_000_000 };
}

describe('Gate 9 — ManualIntentStore fail-closed load (envelope)', () => {
  it('a missing file is MISSING (fresh, genuinely empty)', () => {
    const store = fresh('a');
    expect(store.load().status).toBe('MISSING');
    expect(store.allIntents().size).toBe(0);
  });

  it('a valid file round-trips via save/load', () => {
    const store = fresh('b');
    store.save({ ...validIntent } as never);
    const r = store.load();
    expect(r.status).toBe('OK');
    expect((r as { data: { intents: Record<string, { status: string }> } }).data.intents['manual-i1'].status).toBe('PROPOSED');
    expect(store.get('manual-i1')!.status).toBe('PROPOSED');
  });

  it('malformed JSON is CORRUPT and allIntents throws', () => {
    const store = writeRaw('c', '{ not json');
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(CorruptManualIntentStoreError);
  });

  it('an unsupported envelope version is CORRUPT', () => {
    const store = writeRaw('d', JSON.stringify({ format: 'retrac-state', version: 99, realm: 'live', domain: 'manual-intents', savedAtMs: 1, payload: validPayload() }));
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(CorruptManualIntentStoreError);
  });

  it('a legacy (non-envelope) file is CORRUPT, never read as empty', () => {
    const store = writeRaw('d2', JSON.stringify({ version: 1, intents: { 'manual-i1': validIntent }, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a realm mismatch is CORRUPT (a paper realm file is rejected by the live store)', () => {
    const store = writeRaw('r', JSON.stringify({ format: 'retrac-state', version: 1, realm: 'paper', domain: 'manual-intents', savedAtMs: 1, payload: validPayload() }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a missing intents map is CORRUPT', () => {
    const store = writeRaw('e', envelope({ version: 2, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a malformed intent (invalid status) is CORRUPT', () => {
    const bad = { ...validIntent, status: 'FLYING' };
    const store = writeRaw('f', envelope({ version: 2, intents: { 'manual-i1': bad }, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a malformed Money value is CORRUPT', () => {
    const bad = { ...validIntent, quantity: 'not-a-number' };
    const store = writeRaw('g', envelope({ version: 2, intents: { 'manual-i1': bad }, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a duplicate key / mismatched intentId key is CORRUPT', () => {
    const bad = { ...validIntent, intentId: 'manual-OTHER' };
    const store = writeRaw('h', envelope({ version: 2, intents: { 'manual-i1': bad }, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });

  it('a truncated file is CORRUPT', () => {
    const full = envelope(validPayload());
    const store = writeRaw('i', full.slice(0, full.length - 10));
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(CorruptManualIntentStoreError);
  });

  it('a leftover .tmp file fails closed', () => {
    const p = freshDir('j');
    rmSync(p, { force: true });
    rmSync(`${p}.tmp`, { force: true });
    writeFileSync(p, envelope(validPayload()));
    writeFileSync(`${p}.tmp`, envelope(validPayload()));
    const store = new ManualIntentStore(p);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => store.allIntents()).toThrow(CorruptManualIntentStoreError);
  });

  it('a negative reservation amount is CORRUPT', () => {
    const bad = { ...validIntent, reservationAmount: '-5' } as never;
    const store = writeRaw('k', envelope({ version: 2, intents: { 'manual-i1': bad }, savedAtMs: 1 }));
    expect(store.load().status).toBe('CORRUPT');
  });
});
