/**
 * F-10 — external snapshot replacement semantics & ownership preservation.
 *
 * Core invariant: exchange balance is EVIDENCE of what exists at the exchange;
 * it is NOT sufficient evidence of BOT ownership. Only explicit bot state
 * (positions from fills) and explicit operator declaration/authorization
 * (externalSnapshot / authorizeExternal) establish ownership. Reconciliation is
 * DETECT-ONLY: it must never mutate ownership to make the accounting equation fit.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio, type PortfolioJsonV2 } from '../../../src/portfolio/serialization.js';
import { Reconciler } from '../../../src/reconcile/index.js';
import type { ExchangeAccountSnapshot, LocalOrderLedger } from '../../../src/reconcile/types.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { Balance, MarketInfo } from '../../../src/types.js';

const B = 'BTC/CAD';
const E = 'ETH/CAD';
const NOW = 1_000_000_000;
const PRICE = Money.fromString('40000.00');

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

const marketInfo: MarketInfo = {
  symbol: B, exchangeId: '1', priceTick: Money.fromString('0.01'),
  basePrecision: 8, quotePrecision: 2, quantityTick: Money.fromString('0.00001'),
  minOrderBase: Money.fromString('0.0001'), minOrderQuote: null, supportsMarketOrders: true, feeInfo: null,
};

const EMPTY_LOCAL: LocalOrderLedger = { orders: new Map(), openLocalOrderIds: [] };

function cashPortfolio(cash: string): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
}

function bal(currency: string, amount: string): Balance {
  return { currency, total: Money.fromString(amount), available: Money.fromString(amount), held: Money.zero() };
}

function snapshot(balances: Balance[]): ExchangeAccountSnapshot {
  return { balances, openOrders: [], orderHistory: [], fetchedAtMs: NOW };
}

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  return {
    symbol: B, signal: signal(B, signalType, {}, NOW), nowMs: NOW,
    marketDataTimestampMs: NOW, marketDataObservedAtMs: NOW, price: PRICE, marketInfo,
    quoteBalance: bal('CAD', '100000'), deployableQuote: Money.fromString('100000'),
    portfolioValue: Money.fromString('100000'), peakPortfolioValue: Money.fromString('100000'),
    portfolioExposure: Money.zero(), currentPosition: Money.zero(), externalPosition: Money.zero(),
    openManagedPositionCount: 0, realizedPnlToday: Money.zero(), unrealizedPnlToday: Money.zero(),
    ...over,
  };
}

const risk = () => new RiskManager(riskCfg);

// --- Ownership establishment ---
describe('F-10 — ownership establishment', () => {
  it('external-only authorization creates an EXTERNAL_AUTHORIZED position with zero cost basis', () => {
    const p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.5')]])).authorizeExternal(B);
    const pos = p.position(B)!;
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(pos.quantity.toFixed(8)).toBe('0.50000000');
    expect(pos.costBasis.isZero()).toBe(true);
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.50000000');
    expect(pos.sourceQuantities.BOT.isZero()).toBe(true);
    expect(p.external(B).isZero()).toBe(true); // consumed into managed
  });

  it('a BOT-only position stays BOT when scaled', () => {
    let p = cashPortfolio('1000').applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    p = p.applyFill(B, 'BUY', Money.fromString('0.05'), Money.fromString('40000'), Money.zero());
    const pos = p.position(B)!;
    expect(pos.source).toBe('BOT');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.15000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.isZero()).toBe(true);
  });

  it('mixed BOT + external keeps both provenance (BOT not reclassified)', () => {
    const p = cashPortfolio('1000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const pos = p.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
  });

  it('repeated authorization is a safe idempotent no-op', () => {
    let p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]])).authorizeExternal(B);
    const before = p.position(B)!.quantity.toFixed(8);
    p = p.authorizeExternal(B);
    expect(p.position(B)!.quantity.toFixed(8)).toBe(before);
    expect(p.managedOpenCount()).toBe(1);
  });

  it('authorization survives restart (serialize -> deserialize -> re-authorize is idempotent)', () => {
    let p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]])).authorizeExternal(B);
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    const re = restored.authorizeExternal(B); // must not double-count
    const pos = re.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.25000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
  });
});

// --- Snapshot increases never become BOT / never mutate provenance ---
describe('F-10 — snapshot increases never create BOT ownership', () => {
  it('an unexpected exchange increase over mixed state is a mismatch and does NOT create BOT quantity', () => {
    const p = cashPortfolio('1000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const botBefore = p.position(B)!.sourceQuantities.BOT.toFixed(8);
    const extBefore = p.position(B)!.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8);
    const r = new Reconciler();
    const report = r.reconcile(EMPTY_LOCAL, snapshot([bal('BTC', '0.60')]), { expectedBalances: p.expectedAssetBalances() });
    expect(report.safeToTrade).toBe(false);
    expect(report.discrepancies.some((d) => d.kind === 'BALANCE_MISMATCH')).toBe(true);
    // Provenance (and quantity) unchanged after reconcile.
    expect(p.position(B)!.sourceQuantities.BOT.toFixed(8)).toBe(botBefore);
    expect(p.position(B)!.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe(extBefore);
  });

  it('reconciliation NEVER mutates the portfolio (read-only detection)', () => {
    const p = cashPortfolio('1000').applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    const before = p.stateModel;
    const r = new Reconciler();
    r.reconcile(EMPTY_LOCAL, snapshot([bal('BTC', '0.40')]), { expectedBalances: p.expectedAssetBalances() });
    expect(p.stateModel).toEqual(before); // no adoption, no mutation, no new BOT
  });
});

// --- Snapshot decreases never silently erase/reclassify ---
describe('F-10 — snapshot decreases never silently mutate provenance', () => {
  const cases: Array<[string, string]> = [
    ['0.40', 'below managed+external ... '],
    ['0.10', 'below BOT quantity'],
  ];
  it.each(cases)('exchange %s : mismatch surfaced, provenance preserved', (exchangeBtc) => {
    // BOT 0.2 + external 0.3 => expected 0.5; exchange lower.
    const p = cashPortfolio('1000')
      .applyFill(B, 'BUY', Money.fromString('0.2'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.3')]]))
      .authorizeExternal(B);
    const before = { bt: p.position(B)!.sourceQuantities.BOT.toFixed(8), et: p.position(B)!.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8) };
    const r = new Reconciler();
    const report = r.reconcile(EMPTY_LOCAL, snapshot([bal('BTC', exchangeBtc)]), { expectedBalances: p.expectedAssetBalances() });
    expect(report.safeToTrade).toBe(false);
    expect(p.position(B)!.sourceQuantities.BOT.toFixed(8)).toBe(before.bt);
    expect(p.position(B)!.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe(before.et);
  });
});

// --- Snapshot replacement semantics ---
describe('F-10 — external snapshot replacement', () => {
  it('a later snapshot update (merge-over) preserves prior declared assets and authorization', () => {
    // Initial declaration: external BTC 0.5 + ETH 1.0. Later snapshot: BTC 0.7.
    let p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.5')], [E, Money.fromString('1.0')]]));
    p = p.withExternalSnapshot(new Map([[B, Money.fromString('0.7')]]));
    // Merge-over: BTC updated to 0.7, ETH retained (never silently erased).
    expect(p.external(B).toFixed(8)).toBe('0.70000000');
    expect(p.external(E).toFixed(8)).toBe('1.00000000');
    // Refreshing observation never creates BOT quantity.
    expect(p.position(B)).toBeNull();
    expect(p.position(E)).toBeNull();
    expect(p.managedOpenCount()).toBe(0);
  });

  it('updating the external snapshot cannot erase an existing BOT position or its provenance', () => {
    let p = cashPortfolio('1000').applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero());
    p = p.withExternalSnapshot(new Map([[B, Money.fromString('1.2')]]));
    const pos = p.position(B)!;
    expect(pos.source).toBe('BOT');
    expect(pos.quantity.toFixed(8)).toBe('0.10000000');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
  });

  it('repeated replacement is deterministic (idempotent merge)', () => {
    let p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.5')]]));
    const a = p.withExternalSnapshot(new Map([[B, Money.fromString('0.8')]]));
    const b = p.withExternalSnapshot(new Map([[B, Money.fromString('0.8')]]));
    expect(a.external(B).toFixed(8)).toBe(b.external(B).toFixed(8));
  });
});

// --- Persistence / restart ---
describe('F-10 — persistence / restart', () => {
  it('mixed provenance and external authorization round-trip losslessly', () => {
    const p = cashPortfolio('1000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .applyFill(E, 'BUY', Money.fromString('0.05'), Money.fromString('3000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    expect(restored.position(B)!.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
    expect(restored.position(B)!.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
    expect(restored.position(E)!.source).toBe('BOT');
    expect(restored.isAuthorizedExternal(B)).toBe(true);
    expect(restored.expectedAssetBalances().get('BTC')!.toFixed(8)).toBe('0.35000000');
  });

  it('malformed (negative) external snapshot state fails closed', () => {
    const bad: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000' },
      positions: {},
      peakEquity: '1000',
      realizedPnl: '0',
      totalFees: '0',
      externalSnapshot: { 'BTC': '-0.5' },
    };
    expect(() => deserializePortfolio(bad)).toThrow(/negative external snapshot/);
  });

  it('malformed (negative) position quantity state fails closed', () => {
    const bad: PortfolioJsonV2 = {
      version: 2,
      cash: { CAD: '1000' },
      positions: {
        'BTC/CAD': {
          symbol: 'BTC/CAD', quantity: '-0.1', averageEntryPrice: '40000', costBasis: '-4000',
          realizedPnl: '0', feesPaid: '0', source: 'BOT', sourceQuantities: { BOT: '-0.1', EXTERNAL_AUTHORIZED: '0' },
        },
      },
      peakEquity: '1000',
      realizedPnl: '0',
      totalFees: '0',
    };
    expect(() => deserializePortfolio(bad)).toThrow(/negative position quantity/);
  });
});

// --- Multi-asset isolation ---
describe('F-10 — multi-asset isolation', () => {
  it('a BTC snapshot/authorization change does not affect ETH ownership', () => {
    let p = cashPortfolio('1000')
      .applyFill(E, 'BUY', Money.fromString('0.05'), Money.fromString('3000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')], [E, Money.fromString('2.0')]]))
      .authorizeExternal(B);
    const ethBefore = p.position(E)!.sourceQuantities.BOT.toFixed(8);
    p = p.withExternalSnapshot(new Map([[B, Money.fromString('0.9')]])); // BTC declaration update
    expect(p.position(E)!.source).toBe('BOT');
    expect(p.position(E)!.sourceQuantities.BOT.toFixed(8)).toBe(ethBefore);
    expect(p.position(E)!.quantity.toFixed(8)).toBe('0.05000000');
  });

  it('an external change cannot alter managed CAD cash', () => {
    const p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    const p2 = p.withExternalSnapshot(new Map([[B, Money.fromString('0.9'), 'ETH', Money.fromString('1.0')]]));
    expect(p2.cash('CAD').toFixed(2)).toBe('1000.00');
  });
});

// --- Risk interaction ---
describe('F-10 — risk interaction', () => {
  it('an external snapshot increase does NOT increase managed exposure/positions/deployable', () => {
    const base = cashPortfolio('1000').applyFill(E, 'BUY', Money.fromString('0.05'), Money.fromString('3000'), Money.zero());
    const withExt = base.withExternalSnapshot(new Map([[B, Money.fromString('5.0')]]));
    const px = new Map<string, Money>([['ETH/CAD', Money.fromString('3000')], [B, Money.fromString('40000')]]);
    expect(base.managedOpenCount()).toBe(1);
    expect(withExt.managedOpenCount()).toBe(1); // external never a managed position
    expect(base.exposure(px).toFixed(2)).toBe(withExt.exposure(px).toFixed(2)); // exposure excludes external
    expect(base.deployableQuote('CAD').toFixed(2)).toBe(withExt.deployableQuote('CAD').toFixed(2));
  });

  it('an external-only asset remains unsellable by the bot (no SELL eligible)', () => {
    const p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    const d = risk().evaluate(ctx('SELL', { currentPosition: Money.zero(), externalPosition: p.external(B) }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('SELL_EXCEEDS_MANAGED_POSITION');
  });

  it('a BOT position remains risk-visible and sellable regardless of external changes', () => {
    const p = cashPortfolio('1000')
      .applyFill(E, 'BUY', Money.fromString('0.05'), Money.fromString('3000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('5.0')]]));
    // ETH BOT position is still the managed position for risk/SELL.
    expect(p.managedOpenCount()).toBe(1);
    const d = risk().evaluate(ctx('SELL', { symbol: 'ETH/CAD', signal: signal('ETH/CAD', 'SELL', {}, NOW), currentPosition: p.position('ETH/CAD')!.quantity, externalPosition: Money.zero() }));
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.05000000');
  });
});

// --- Reservation interaction ---
describe('F-10 — reservation independence', () => {
  it('an external snapshot update cannot release/create reservations, and reserved quote stays', () => {
    let p = cashPortfolio('1000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    p = p.reserveQuote('CAD', Money.fromString('300'));
    const before = p.reserved('CAD').toFixed(2);
    p = p.withExternalSnapshot(new Map([[B, Money.fromString('0.8'), 'ETH', Money.fromString('1')]]));
    expect(p.reserved('CAD').toFixed(2)).toBe(before);
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('700.00');
  });

  it('reconciliation cannot release or create a reservation', () => {
    const p = cashPortfolio('1000').reserveQuote('CAD', Money.fromString('300'));
    const before = p.reserved('CAD').toFixed(2);
    new Reconciler().reconcile(EMPTY_LOCAL, snapshot([]), { expectedBalances: p.expectedAssetBalances() });
    expect(p.reserved('CAD').toFixed(2)).toBe(before);
  });
});
