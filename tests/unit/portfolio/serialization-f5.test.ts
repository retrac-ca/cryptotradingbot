/**
 * F-5 — legacy state migration / ownership persistence hardening.
 *
 * Adversarial regression tests for the fail-closed ownership model:
 *   - Ambiguous / malformed ownership NEVER silently becomes BOT-managed live
 *     inventory (no implicit `?? 'BOT'`).
 *   - Legacy PAPER state is deterministically migrated as historical BOT (it was
 *     a simulated bot trade); legacy LIVE state fails closed.
 *   - Quantity is conserved (`BOT + EXTERNAL_AUTHORIZED === quantity`).
 *   - Cost basis is preserved where historically known and never invented for a
 *     pure external position.
 *   - Migration cannot alter exchange truth, adopt exchange balances, or create a
 *     position that was not present in the persisted state.
 *   - A truly-legacy live position cannot cause a SELL of exchange inventory.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  serializePortfolio,
  deserializePortfolio,
  PORTFOLIO_STATE_VERSION,
  type PortfolioJson,
  type PortfolioJsonV1,
  type PortfolioJsonV2,
} from '../../../src/portfolio/serialization.js';
import { PaperStateStore, ManagedStateStore } from '../../../src/persistence/index.js';
import { loadLiveManagedPortfolio } from '../../../src/cli/live-test-cmd.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo, Balance } from '../../../src/types.js';
import type { BotConfig } from '../../../src/config/schema.js';

const B = 'BTC/CAD';
const PRICE = Money.fromString('40000.00');
const PORTFOLIO_VAL = Money.fromString('100000.00');
const QTY_TICK = Money.fromString('0.00001');
const PRICE_TICK = Money.fromString('0.01');
const MIN_BASE = Money.fromString('0.0001');
const NOW = 1_000_000_000;

const PAPER_FILE = '/tmp/opencode/f5-paper.json';
const LIVE_FILE = '/tmp/opencode/f5-live.json';

function clearFiles(): void {
  rmSync(PAPER_FILE, { force: true });
  rmSync(LIVE_FILE, { force: true });
  rmSync(`${PAPER_FILE}.tmp`, { force: true });
  rmSync(`${LIVE_FILE}.tmp`, { force: true });
  // `loadLiveManagedPortfolio` now consults/creates the state-init marker in the
  // shared state directory; reset it so each test starts from a genuine first run.
  rmSync('/tmp/opencode/.init.json', { force: true });
}

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return { liveManagedStateFile: LIVE_FILE, paperStateFile: PAPER_FILE, ...over } as BotConfig;
}

function env(realm: 'paper' | 'live', payload: unknown): string {
  return JSON.stringify({ format: 'retrac-state', version: 1, realm, domain: 'portfolio', savedAtMs: NOW, payload });
}

const marketInfo: MarketInfo = {
  symbol: B,
  exchangeId: '1',
  priceTick: PRICE_TICK,
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: QTY_TICK,
  minOrderBase: MIN_BASE,
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: null,
};

const riskCfg: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.1,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 3600_000,
  maxOpenPositions: 1,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  const balance: Balance = { currency: 'CAD', total: Money.fromString('100000'), available: Money.fromString('100000'), held: Money.zero() };
  return {
    symbol: B,
    signal: signal(B, signalType, {}, NOW),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: PRICE,
    marketInfo,
    quoteBalance: balance,
    deployableQuote: Money.fromString('100000'),
    portfolioValue: PORTFOLIO_VAL,
    peakPortfolioValue: PORTFOLIO_VAL,
    portfolioExposure: Money.zero(),
    currentPosition: Money.zero(),
    externalPosition: Money.zero(),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.zero(),
    unrealizedPnlToday: Money.zero(),
    ...over,
  };
}

function legacyV1NoSource(): PortfolioJsonV1 {
  return {
    version: 1,
    cash: { CAD: '96000.00000000', BTC: '0.00000000' },
    positions: {
      'BTC/CAD': {
        symbol: B,
        quantity: '0.35000000',
        averageEntryPrice: '11428.57142857',
        costBasis: '4000.00000000',
        realizedPnl: '0.00000000',
        feesPaid: '0.00000000',
        // NOTE: no `source`, no `sourceQuantities` — the truly-legacy pre-Gate-5 shape.
      },
    },
    peakEquity: '100000.00000000',
    realizedPnl: '0.00000000',
    totalFees: '0.00000000',
  };
}

// --- 1 & 10. Current format round-trips losslessly; mixed provenance survives. ---
describe('F-5 — current explicit (v2) state', () => {
  beforeEach(clearFiles);

  it('round-trips a mixed-ownership position losslessly', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const doc = serializePortfolio(p.stateModel);
    expect(doc.version).toBe(PORTFOLIO_STATE_VERSION);
    expect(doc.positions[B]!.source).toBe('BOT');
    const restored = Portfolio.fromModel(deserializePortfolio(doc));
    const pos = restored.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    expect(pos.costBasis.toFixed(8)).toBe('4000.00000000');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
    // Lossless: serializing the restored model reproduces an identical document.
    expect(serializePortfolio(restored.stateModel)).toEqual(doc);
  });

  it('preserves pure-EXTERNAL_AUTHORIZED provenance and zero external cost basis', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .withExternalSnapshot(new Map([[B, Money.fromString('0.5')]]))
      .authorizeExternal(B);
    const doc = serializePortfolio(p.stateModel) as PortfolioJsonV2;
    const pos = doc.positions[B]!;
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED).toBe('0.50000000');
    expect(pos.sourceQuantities.BOT).toBe('0.00000000');
    expect(pos.costBasis).toBe('0.00000000'); // never invents cost basis for pre-owned external
    const restored = deserializePortfolio(doc).positions.get(B)!;
    expect(restored.costBasis.isZero()).toBe(true);
    expect(restored.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.50000000');
  });
});

// --- 4 & A. Legacy state cannot silently create/expand live-managed inventory. ---
describe('F-5 — legacy paper must not become live-managed', () => {
  beforeEach(clearFiles);

  it('accepts a legacy no-source document in the PAPER realm as historical BOT', () => {
    const model = deserializePortfolio(legacyV1NoSource(), { realm: 'paper' });
    const pos = model.positions.get(B)!;
    expect(pos.source).toBe('BOT');
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.35000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.isZero()).toBe(true);
  });

  it('rejects the SAME legacy no-source document in the LIVE realm (fail closed)', () => {
    expect(() => deserializePortfolio(legacyV1NoSource(), { realm: 'live' })).toThrow(/no ownership source/);
  });

  it('a legacy paper position never appears in the live managed portfolio', () => {
    const paper = new PaperStateStore(PAPER_FILE);
    paper.save(deserializePortfolio(legacyV1NoSource(), { realm: 'paper' }), ['p1']);
    const live = loadLiveManagedPortfolio(cfg());
    expect(live.position(B)).toBeNull();
    expect(live.managedOpenCount()).toBe(0);
    expect(live.external(B).isZero()).toBe(true);
  });

  it('a legacy live state file is CORRUPT (HALT), never adopted as inventory', () => {
    const file = legacyV1NoSource();
    writeFileSync(LIVE_FILE, env('live', file));
    const store = new ManagedStateStore(LIVE_FILE);
    expect(store.load().status).toBe('CORRUPT');
    expect(() => loadLiveManagedPortfolio(cfg())).toThrow(/live managed state is corrupt/i);
  });
});

// --- 5. Malformed / ambiguous ownership fails closed. ---
describe('F-5 — malformed ownership fails closed', () => {
  it('rejects a v2 position whose provenance does not conserve quantity', () => {
    const doc: PortfolioJsonV2 = {
      ...legacyV1NoSource(),
      version: 2,
      positions: {
        [B]: {
          symbol: B, quantity: '0.35000000', averageEntryPrice: '11428.57142857', costBasis: '4000.00000000',
          realizedPnl: '0.00000000', feesPaid: '0.00000000', source: 'BOT',
          sourceQuantities: { BOT: '0.10000000', EXTERNAL_AUTHORIZED: '0.10000000' },
        },
      },
    };
    expect(() => deserializePortfolio(doc)).toThrow(/does not equal quantity/);
  });

  it('rejects a position with an unknown source value (never defaults to BOT)', () => {
    const doc: PortfolioJsonV2 = {
      ...legacyV1NoSource(),
      version: 2,
      positions: {
        [B]: {
          symbol: B, quantity: '0.35000000', averageEntryPrice: '11428.57142857', costBasis: '4000.00000000',
          realizedPnl: '0.00000000', feesPaid: '0.00000000', source: 'HACKED' as never,
          sourceQuantities: { BOT: '0.35000000', EXTERNAL_AUTHORIZED: '0.00000000' },
        },
      },
    };
    expect(() => deserializePortfolio(doc)).toThrow(/unknown position source/);
  });

  it('rejects conflicting provenance with an unknown coarse source in any realm', () => {
    const pos = legacyV1NoSource().positions[B]!;
    const doc: PortfolioJsonV1 = {
      ...legacyV1NoSource(),
      // no `source`, but a MIXED provenance that cannot be attributed -> ambiguous.
      positions: {
        [B]: { ...pos, source: undefined, sourceQuantities: { BOT: '0.10000000', EXTERNAL_AUTHORIZED: '0.25000000' } },
      },
    };
    expect(() => deserializePortfolio(doc, { realm: 'paper' })).toThrow(/ambiguous/);
    expect(() => deserializePortfolio(doc, { realm: 'live' })).toThrow(/ambiguous/);
  });

  it('rejects an unsupported state version (fail closed)', () => {
    const doc = { ...legacyV1NoSource(), version: 99 } as unknown as PortfolioJson;
    expect(() => deserializePortfolio(doc)).toThrow(/unsupported version/);
  });
});

// --- 3. Chosen migration semantics for truly-legacy paper state. ---
describe('F-5 — legacy paper migration is deterministic and explicit', () => {
  it('preserves quantity and cost basis exactly', () => {
    const model = deserializePortfolio(legacyV1NoSource(), { realm: 'paper' });
    const pos = model.positions.get(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    expect(pos.costBasis.toFixed(8)).toBe('4000.00000000');
    expect(pos.averageEntryPrice.toFixed(8)).toBe('11428.57142857');
    expect(pos.realizedPnl.toFixed(8)).toBe('0.00000000');
    expect(pos.feesPaid.toFixed(8)).toBe('0.00000000');
  });

  it('serializes a migrated legacy model into the current explicit v2 format', () => {
    const model = deserializePortfolio(legacyV1NoSource(), { realm: 'paper' });
    const doc = serializePortfolio(model);
    expect(doc.version).toBe(PORTFOLIO_STATE_VERSION);
    const pos = doc.positions[B]!;
    expect(pos.source).toBe('BOT');
    expect(pos.sourceQuantities.BOT).toBe('0.35000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED).toBe('0.00000000');
  });
});

// --- B. A legacy live state can never cause a SELL of exchange inventory. ---
describe('F-5 — legacy live state cannot drive a SELL', () => {
  beforeEach(clearFiles);

  it('empty live-managed portfolio yields currentPosition 0 and SELL is rejected', () => {
    // No live file at all => MISSING => empty managed portfolio.
    const live = loadLiveManagedPortfolio(cfg());
    const risk = new RiskManager(riskCfg);
    const d = risk.evaluate(ctx('SELL', { currentPosition: live.position(B)?.quantity ?? Money.zero() }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('NO_ACTION');
  });

  it('a SELL never exceeds the managed quantity derived from safe deserialization', () => {
    // Sanity: when a legitimately-authorized position exists, the SELL ceiling is bounded.
    const live = Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]))
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const risk = new RiskManager(riskCfg);
    const d = risk.evaluate(ctx('SELL', { currentPosition: live.position(B)!.quantity, externalPosition: live.external(B) }));
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.compareTo(live.position(B)!.quantity)).toBeLessThanOrEqual(0);
  });
});

// --- G. Migration cannot create positions that were not persisted. ---
describe('F-5 — migration is faithful to the persisted document', () => {
  it('deserializes exactly the positions present in the document', () => {
    const model = deserializePortfolio(legacyV1NoSource(), { realm: 'paper' });
    expect(model.positions.size).toBe(1);
    expect([...model.positions.keys()]).toEqual([B]);
    const doc = serializePortfolio(model);
    expect(Object.keys(doc.positions)).toEqual([B]);
  });
});

// --- F. Migration never adopts exchange balances. ---
describe('F-5 — no silent exchange-balance adoption', () => {
  beforeEach(clearFiles);

  it('a missing live state produces an empty managed portfolio, not an adopted exchange position', () => {
    const live = loadLiveManagedPortfolio(cfg());
    expect(live.position(B)).toBeNull();
    expect(live.stateModel.positions.size).toBe(0);
    expect(live.stateModel.externalSnapshot.size).toBe(0);
    expect(live.expectedAssetBalances().size).toBe(0);
  });
});

// --- Direct store mismatch: same legacy doc accepted by paper, rejected by live. ---
describe('F-5 — paper/live store realm divergence on the same legacy document', () => {
  beforeEach(clearFiles);

  it('paper store migrates a legacy no-source doc; live store rejects it', () => {
    // Write the same legacy document as an envelope to BOTH stores' files.
    writeFileSync(PAPER_FILE, env('paper', { ...legacyV1NoSource(), executedOrderIds: [] }));
    writeFileSync(LIVE_FILE, env('live', legacyV1NoSource()));

    const paperLoad = new PaperStateStore(PAPER_FILE).load();
    expect(paperLoad.status).toBe('OK');
    if (paperLoad.status !== 'OK') return;
    const paperModel = new PaperStateStore(PAPER_FILE).toPortfolio(paperLoad.data);
    expect(paperModel!.positions.get(B)!.source).toBe('BOT'); // historical paper BOT preserved

    const liveLoad = new ManagedStateStore(LIVE_FILE).load();
    expect(liveLoad.status).toBe('CORRUPT'); // ambiguous in live -> fail closed -> HALT
  });
});
