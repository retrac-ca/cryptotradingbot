/**
 * F-9 — reservation lifecycle.
 *
 * Adversarial tests against the REAL Portfolio + RiskManager. The reservation
 * model is a currency-and-amount scoped (fungible) pool: `reserveQuote` adds,
 * `releaseQuote` subtracts, and `deployableQuote`/`deployableQuoteBounded`
 * subtract the reserved amount from the deployable pool.
 *
 * The invariants under test:
 *   A. Reserved quote is never deployable.
 *   B. A reservation cannot exceed the deployable pool (fail closed).
 *   C. Fate of a reservation is tied to the order lifecycle (reserve before
 *      submit, release only on a terminal outcome). NOTE: the live BUY loop is
 *      not yet wired (see module doc), so the lifecycle is exercised here via
 *      deterministic sequences on the real primitives. Order-identity is NOT
 *      modeled; the pool is fungible by currency+amount. This is safe provided
 *      each order releases exactly its own amount (enforced by fail-closed
 *      release) — documented limitation.
 *   D. Release is exactly-once and cannot over-release / corrupt another order.
 *   E. Restart preserves reservations; corrupt reserved state fails closed.
 *   F. Failed submission releases the reservation.
 *   G. Unknown/open order RETAINS the reservation.
 *   H. Terminal fill settles (applyFill + release) exactly once.
 *   I. Partial fills: the reservation is reduced by the consumed amount and the
 *      remainder retained until terminal completion (documented policy — the
 *      architecture does not tie reservations to order identity).
 *   J. Multiple reservations do not corrupt one another.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import {
  serializePortfolio,
  deserializePortfolio,
  type PortfolioJson,
  type PortfolioJsonV2,
} from '../../../src/portfolio/serialization.js';
import { ManagedStateStore } from '../../../src/persistence/index.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo, Balance } from '../../../src/types.js';

const BTC = 'BTC/CAD';
const NOW = 1_000_000_000;
const PRICE = Money.fromString('40000.00');

const stateFile = join(mkdtempSync(join(tmpdir(), 'retrac-f9-')), 'live-state.json');
function clear() {
  rmSync(stateFile, { force: true });
  rmSync(`${stateFile}.tmp`, { force: true });
}

const marketInfo: MarketInfo = {
  symbol: BTC,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00001'),
  minOrderBase: Money.fromString('0.0001'),
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

const risk = () => new RiskManager(riskCfg);

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  const b: Balance = { currency: 'CAD', total: Money.fromString('1000'), available: Money.fromString('1000'), held: Money.zero() };
  return {
    symbol: BTC,
    signal: signal(BTC, signalType, {}, NOW),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: PRICE,
    marketInfo,
    quoteBalance: b,
    deployableQuote: Money.fromString('1000'),
    portfolioValue: Money.fromString('100000.00'),
    peakPortfolioValue: Money.fromString('100000.00'),
    portfolioExposure: Money.zero(),
    currentPosition: Money.zero(),
    externalPosition: Money.zero(),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.zero(),
    unrealizedPnlToday: Money.zero(),
    ...over,
  };
}

function portfolio(cash: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
}

function bal(total: string, held: string): Balance {
  const t = Money.fromString(total);
  const h = Money.fromString(held);
  return { currency: 'CAD', total: t, available: t.sub(h), held: h };
}

// --- A. Reserved quote is never deployable. ---
describe('F-9 — Invariant A: reserved quote is not deployable', () => {
  it('deployableQuote decreases by exactly the reservation', () => {
    let p = portfolio('1000');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('1000.00');
    p = p.reserveQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00');
  });

  it('a reservation reduces deployable up to the point the BUY fails (RiskManager)', () => {
    // portfolioValue 5000 => 10% position cap = 500 notional.
    const free = portfolio('1000');
    const d1 = risk().evaluate(
      ctx('BUY', { portfolioValue: Money.fromString('5000.00'), peakPortfolioValue: Money.fromString('5000.00'), deployableQuote: free.deployableQuote('CAD'), quoteBalance: bal('1000', '0') }),
    );
    expect(d1.approved).toBe(true); // 500 <= 1000

    const reserved = portfolio('1000').reserveQuote('CAD', Money.fromString('600'));
    expect(reserved.deployableQuote('CAD').toFixed(2)).toBe('400.00');
    const d2 = risk().evaluate(
      ctx('BUY', { portfolioValue: Money.fromString('5000.00'), peakPortfolioValue: Money.fromString('5000.00'), deployableQuote: reserved.deployableQuote('CAD'), quoteBalance: bal('1000', '0') }),
    );
    expect(d2.approved).toBe(false);
    if (!d2.approved) expect(d2.reason).toBe('INSUFFICIENT_BALANCE');
  });
});

// --- B. Cannot reserve more than the deployable pool (fail closed). ---
describe('F-9 — Invariant B: reservation cannot exceed the pool', () => {
  it('throws when reserving more than the deployable quote', () => {
    const p = portfolio('1000');
    expect(() => p.reserveQuote('CAD', Money.fromString('1000.01'))).toThrow(/exceeds deployable quote/);
    expect(() => p.reserveQuote('CAD', Money.fromString('1500'))).toThrow(/exceeds deployable quote/);
  });

  it('allows reserving exactly the full deployable pool', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('1000'));
    expect(p.reserved('CAD').toFixed(2)).toBe('1000.00');
    expect(p.deployableQuote('CAD').isZero()).toBe(true);
  });

  it('throwing reservation does not mutate the portfolio', () => {
    const p = portfolio('1000');
    expect(() => p.reserveQuote('CAD', Money.fromString('2000'))).toThrow();
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.cash('CAD').toFixed(2)).toBe('1000.00');
  });

  it('zero reservation is a no-op; negative reservation is rejected', () => {
    const p = portfolio('1000');
    expect(p.reserveQuote('CAD', Money.zero())).toBe(p);
    expect(() => p.reserveQuote('CAD', Money.fromString('-5'))).toThrow(/negative amount/);
  });
});

// --- J & D & C. Multiple reservations + exactly-once release. ---
describe('F-9 — Invariant J&D: multiple reservations, exactly-once release', () => {
  it('two reservations coexist and release independently without corrupting each other', () => {
    let p = portfolio('1000');
    p = p.reserveQuote('CAD', Money.fromString('300')); // A
    p = p.reserveQuote('CAD', Money.fromString('200')); // B
    expect(p.reserved('CAD').toFixed(2)).toBe('500.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('500.00');

    // Release A exactly once -> B remains.
    p = p.releaseQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').toFixed(2)).toBe('200.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('800.00');

    // Double-release A must NOT consume B (safe idempotent no-op).
    const after = p.releaseQuote('CAD', Money.fromString('300'));
    expect(after.reserved('CAD').toFixed(2)).toBe('200.00');
    expect(after.deployableQuote('CAD').toFixed(2)).toBe('800.00');
  });

  it('releasing both restores the original deployable amount', () => {
    let p = portfolio('1000');
    p = p.reserveQuote('CAD', Money.fromString('300'));
    p = p.reserveQuote('CAD', Money.fromString('200'));
    p = p.releaseQuote('CAD', Money.fromString('200'));
    p = p.releaseQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('1000.00');
  });

  it('cannot release more than reserved (no-op, never negative)', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    expect(p.releaseQuote('CAD', Money.fromString('500')).reserved('CAD').toFixed(2)).toBe('300.00');
  });

  it('a wrong-currency release leaves the reservation intact', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    expect(p.releaseQuote('USD', Money.fromString('300')).reserved('CAD').toFixed(2)).toBe('300.00');
  });

  it('negative release is rejected; zero release is a no-op', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    expect(() => p.releaseQuote('CAD', Money.fromString('-1'))).toThrow(/negative amount/);
    expect(p.releaseQuote('CAD', Money.zero())).toBe(p);
  });
});

// --- F, G, H. Failure/unknown/terminal lifecycle (deterministic sequences). ---
describe('F-9 — Invariant F&G&H: order lifecycle', () => {
  it('reserve -> submission failure -> release (no leak)', () => {
    let p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    // submission failed before any authoritative accept:
    p = p.releaseQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('1000.00');
    expect(p.cash('CAD').toFixed(2)).toBe('1000.00');
  });

  it('reserve -> unknown/ambiguous submission -> reservation RETAINED', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    // Unknown outcome: must NOT release.
    expect(p.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00');
    // cash unchanged (no fill claimed).
    expect(p.cash('CAD').toFixed(2)).toBe('1000.00');
  });

  it('reserve -> accepted/open order -> reservation RETAINED', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00');
  });

  it('reserve -> terminal cancel/rejection -> release exactly once', () => {
    let p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    // Final release (order cancelled/rejected, no fill):
    p = p.releaseQuote('CAD', Money.fromString('300'));
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('1000.00');
  });

  it('reserve -> terminal fill -> applyFill + release settles exactly once (no double count)', () => {
    let p = portfolio('1000');
    const R = Money.fromString('300');
    p = p.reserveQuote('CAD', R);
    // Fill: buy 0.0075 BTC @ 40000 = 300 notional, fee 0.
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.0075'), Money.fromString('40000'), Money.zero());
    expect(p.cash('CAD').toFixed(2)).toBe('700.00');
    // Release the reservation on terminal fill.
    p = p.releaseQuote('CAD', R);
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00'); // cash - 0 reserved
    // The fill cost is counted exactly once (via applyFill), not twice.
    expect(p.cash('CAD').toFixed(2)).toBe('700.00');
    expect(p.position(BTC)!.quantity.toFixed(8)).toBe('0.00750000');
  });
});

// --- I. Partial fill policy. ---
describe('F-9 — Invariant I: partial-fill reservation accounting', () => {
  it('reduces the reservation by the consumed amount and retains the remainder until terminal', () => {
    // Order reserves 400. It partial-fills 200 (consumed), leaving 200 reserved.
    let p = portfolio('1000').reserveQuote('CAD', Money.fromString('400'));
    const consumed = Money.fromString('200');
    const remaining = Money.fromString('200');
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.005'), Money.fromString('40000'), Money.zero()); // 200 cost
    // Release ONLY the consumed portion; the remainder stays reserved.
    p = p.releaseQuote('CAD', consumed);
    expect(p.reserved('CAD').toFixed(2)).toBe('200.00');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('600.00'); // 800 cash - 200 reserved
    // Terminal completion of the remainder:
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.005'), Money.fromString('40000'), Money.zero()); // 200 cost
    p = p.releaseQuote('CAD', remaining);
    expect(p.reserved('CAD').isZero()).toBe(true);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('600.00'); // cash now 600, reserved 0
  });

  it('does not falsely claim order-identity: releasing the wrong amount fails closed', () => {
    // A partial-fill lifecycle that releases MORE than the remaining reservation
    // is refused => it cannot over-release the pool.
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('400'));
    const over = p.releaseQuote('CAD', Money.fromString('500'));
    expect(over.reserved('CAD').toFixed(2)).toBe('400.00');
  });
});

// --- E. Restart persistence + corrupt fail-closed. ---
describe('F-9 — Invariant E: persistence / restart', () => {
  beforeEach(clear);

  it('reservation survives serialize -> deserialize exactly', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    const doc = serializePortfolio(p.stateModel);
    expect(doc.reserved?.['CAD']).toBe('300.00000000');
    const restored = Portfolio.fromModel(deserializePortfolio(doc));
    expect(restored.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(restored.cash('CAD').toFixed(2)).toBe('1000.00');
    expect(restored.deployableQuote('CAD').toFixed(2)).toBe('700.00');
  });

  it('reserved amount is preserved exactly (not just deployable)', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('423.12'));
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    expect(restored.reserved('CAD').toFixed(2)).toBe('423.12');
  });

  it('negative reserved state fails closed (would otherwise inflate deployable)', () => {
    const bad: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000.00000000' },
      positions: {},
      peakEquity: '1000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
      reserved: { CAD: '-5.00000000' },
    };
    expect(() => deserializePortfolio(bad)).toThrow(/negative reserved/);
  });

  it('reserved greater than cash fails closed (impossible state)', () => {
    const bad: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '100.00000000' },
      positions: {},
      peakEquity: '100.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
      reserved: { CAD: '500.00000000' },
    };
    expect(() => deserializePortfolio(bad)).toThrow(/exceeds cash/);
  });

  it('a corrupt persisted live state is CORRUPT (ManagedStateStore fail-closed)', () => {
    writeFileSync(stateFile, JSON.stringify({ version: 2, cash: { CAD: '100' }, positions: {}, peakEquity: '100', realizedPnl: '0', totalFees: '0', reserved: { CAD: '-5' } }));
    expect(new ManagedStateStore(stateFile).load().status).toBe('CORRUPT');
  });

  it('a valid persisted live state round-trips and restores deployable', () => {
    const p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    const store = new ManagedStateStore(stateFile);
    store.save(p.stateModel);
    const r = store.load();
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    const restored = store.toPortfolio(r.data)!;
    expect(restored.reserved('CAD').toFixed(2)).toBe('300.00');
    expect(restored.deployableQuote('CAD').toFixed(2)).toBe('700.00');
  });
});

// --- F-7 interaction. ---
describe('F-9 — F-7 interaction: held quote and reservation never double-subtracted', () => {
  it('deployableQuoteBounded = min(cash, exchangeAvailable) - reserved (held excluded once)', () => {
    const p = portfolio('100').reserveQuote('CAD', Money.fromString('20'));
    // Exchange: total 100, held 30 => available 70. pool = min(100,70)=70; net=70-20=50.
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).toBe('50.00');
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).not.toBe('30.00'); // no held+reserved double count
  });

  it('deployableQuoteBounded is bounded by exchange available (never exceeds it)', () => {
    // Exchange available binds (70 after 30 held); bot cash (200) is not the limiter.
    const p = portfolio('200');
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).toBe('70.00');
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).compareTo(Money.fromString('70'))).toBeLessThanOrEqual(0);
  });

  it('deployableQuoteBounded never exceeds managed cash', () => {
    const p = portfolio('50');
    expect(p.deployableQuoteBounded('CAD', bal('200', '0')).toFixed(2)).toBe('50.00');
  });

  it('reservation + exchange held cannot make deployable negative', () => {
    const p = portfolio('100').reserveQuote('CAD', Money.fromString('80'));
    const d = p.deployableQuoteBounded('CAD', bal('100', '30'));
    expect(d.isZero()).toBe(true);
    expect(d.isNegative()).toBe(false);
  });

  it('a malformed exchange balance still fails closed even with a reservation present', () => {
    const p = portfolio('100').reserveQuote('CAD', Money.fromString('20'));
    expect(p.deployableQuoteBounded('CAD', null).isZero()).toBe(true);
    expect(p.deployableQuoteBounded('CAD', { currency: 'CAD', total: Money.fromString('100'), available: Money.fromString('-5'), held: Money.zero() }).isZero()).toBe(true);
  });
});

// --- Ownership regression. ---
describe('F-9 — ownership regression', () => {
  it('reservation changes quote deployability only, not managed base-asset ownership', () => {
    let p = portfolio('1000').withExternalSnapshot(new Map([[BTC, Money.fromString('0.25')]]));
    p = p.reserveQuote('CAD', Money.fromString('300'));
    expect(p.position(BTC)).toBeNull(); // external is NOT a managed position
    expect(p.external(BTC).toFixed(8)).toBe('0.25000000');
    expect(p.managedOpenCount()).toBe(0);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00'); // only quote affected
  });

  it('external crypto remains unsellable even with a reservation present', () => {
    const p = portfolio('1000').withExternalSnapshot(new Map([[BTC, Money.fromString('0.25')]])).reserveQuote('CAD', Money.fromString('300'));
    const d = risk().evaluate(ctx('SELL', { currentPosition: Money.zero(), externalPosition: p.external(BTC) }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('SELL_EXCEEDS_MANAGED_POSITION');
  });

  it('a managed BUY position created after reservation is BOT-owned and unaffected', () => {
    let p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.0075'), Money.fromString('40000'), Money.zero());
    expect(p.position(BTC)!.source).toBe('BOT');
    expect(p.managedOpenCount()).toBe(1);
  });
});

// --- Mixed base/quote conservation sanity. ---
describe('F-9 — sanity: reserved does not leak into equity/exposure', () => {
  it('reserved quote is not part of position equity or exposure', () => {
    let p = portfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    p = p.applyFill(BTC, 'BUY', Money.fromString('0.01'), Money.fromString('40000'), Money.zero());
    // Equity based on cash (1000-400=600) + cost basis (400) = 1000; reserved ignored.
    const mtm = p.markToMarket(new Map([[BTC, Money.fromString('40000')]]));
    expect(mtm.equity.toFixed(2)).toBe('1000.00');
    // Reserved is deployable-only bookkeeping; does not inflate exposure.
    expect(p.exposure(new Map([[BTC, Money.fromString('40000')]])).toFixed(2)).toBe('400.00');
  });
});

// --- Unsupported-version / failed state load reuse (fail closed). ---
describe('F-9 — unsupported state version fails closed', () => {
  it('a future/unsupported version with a reservation shape is rejected', () => {
    const bad = { ...({ version: 2, cash: { CAD: '1000' }, positions: {}, peakEquity: '1000', realizedPnl: '0', totalFees: '0', reserved: { CAD: '300' } } as PortfolioJsonV2), version: 9 } as unknown as PortfolioJson;
    expect(() => deserializePortfolio(bad)).toThrow(/unsupported version/);
  });
});
