import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio, type PortfolioJsonV1 } from '../../../src/portfolio/serialization.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo, Balance } from '../../../src/types.js';

const B = 'BTC/CAD';
const BTC = 'BTC';

const PRICE = Money.fromString('40000.00');
const PORTFOLIO = Money.fromString('100000.00');
const QTY_TICK = Money.fromString('0.00001');
const PRICE_TICK = Money.fromString('0.01');
const MIN_BASE = Money.fromString('0.0001');
const NOW = 1_000_000_000;

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

function seed(initialCad: string): Portfolio {
  const cash = new Map<string, Money>();
  cash.set('CAD', Money.fromString(initialCad));
  return Portfolio.empty(cash);
}

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  const balance: Balance = {
    currency: 'CAD',
    total: Money.fromString('100000'),
    available: Money.fromString('100000'),
    held: Money.zero(),
  };
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
    portfolioValue: PORTFOLIO,
    peakPortfolioValue: PORTFOLIO,
    portfolioExposure: Money.zero(),
    currentPosition: Money.zero(),
    externalPosition: Money.zero(),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.zero(),
    unrealizedPnlToday: Money.zero(),
    ...over,
  };
}

function risk(): RiskManager {
  return new RiskManager(riskCfg);
}

// TEST 1 — Pure external authorization
describe('F-6 authorizeExternal — pure external inventory', () => {
  it('moves external quantity into managed EXTERNAL_AUTHORIZED inventory without loss', () => {
    const p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    const p2 = p.authorizeExternal(B);
    const pos = p2.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.25000000');
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(p2.external(B).isZero()).toBe(true);
    expect(p2.managedOpenCount()).toBe(1);
    // Reconciliation: expected exchange balance is unchanged (X moved, not destroyed).
    expect(p2.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe('0.25000000');
  });
});

// TEST 2 — External + BOT-managed authorization
describe('F-6 authorizeExternal — external already coexists with BOT-managed', () => {
  it('preserves BOTH quantities (managed = X + Y), losing none', () => {
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    expect(p.position(B)!.quantity.toFixed(8)).toBe('0.10000000'); // pre-condition
    const p2 = p.authorizeExternal(B);
    const pos = p2.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000'); // X + Y, none lost
    expect(p2.external(B).isZero()).toBe(true); // external consumed into managed
    expect(p2.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe('0.35000000');
    expect(p2.managedOpenCount()).toBe(1);
  });
});

// TEST 3 — Repeated authorization
describe('F-6 authorizeExternal — idempotency', () => {
  it('is a safe no-op when repeated after the external snapshot is consumed', () => {
    let p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    p = p.authorizeExternal(B);
    const before = p.position(B)!.quantity.toFixed(8);
    const expected = p.expectedAssetBalances().get(BTC)!.toFixed(8);
    const p2 = p.authorizeExternal(B); // repeat
    expect(p2.position(B)!.quantity.toFixed(8)).toBe(before); // no inflation
    expect(p2.external(B).isZero()).toBe(true); // no external reappears
    expect(p2.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe(expected); // no drift
    expect(p2.managedOpenCount()).toBe(1);
  });

  it('is a safe no-op after the authorized position was fully sold and no external remains', () => {
    let p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]])).authorizeExternal(B);
    // Fully exit the authorized position.
    p = p.applyFill(B, 'SELL', Money.fromString('0.25'), Money.fromString('40000'), Money.zero());
    expect(p.position(B)).toBeNull();
    expect(p.isAuthorizedExternal(B)).toBe(true);
    // Re-authorizing with no external inventory must not manufacture a position.
    const p2 = p.authorizeExternal(B);
    expect(p2.position(B)).toBeNull();
    expect(p2.managedOpenCount()).toBe(0);
    expect(p2.expectedAssetBalances().has(BTC)).toBe(false);
  });
});

// TEST 4 — Authorization without external quantity
describe('F-6 authorizeExternal — no external quantity', () => {
  it('does not manufacture a positive managed position', () => {
    const p = seed('100000');
    expect(() => p.authorizeExternal(B)).toThrow(/no external inventory/);
    expect(p.position(B)).toBeNull();
    expect(p.managedOpenCount()).toBe(0);
    expect(p.expectedAssetBalances().has(BTC)).toBe(false);
  });
});

// TEST 5 — Unauthorized external remains protected
describe('F-6 SELL protection — unauthorized external', () => {
  it('rejects a SELL that would consume unauthorized external inventory', () => {
    const p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]));
    expect(p.position(B)).toBeNull();
    const d = risk().evaluate(ctx('SELL', { currentPosition: Money.zero(), externalPosition: p.external(B) }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('SELL_EXCEEDS_MANAGED_POSITION');
  });
});

// TEST 6 — Authorized external can be sold
describe('F-6 SELL — authorized external is bot-managed and tradable', () => {
  it('allows a SELL up to the fully-managed quantity once authorized', () => {
    const p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.25')]])).authorizeExternal(B);
    const d = risk().evaluate(ctx('SELL', { currentPosition: p.position(B)!.quantity, externalPosition: p.external(B) }));
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.compareTo(p.position(B)!.quantity)).toBeLessThanOrEqual(0);
  });
});

// TEST 7 — Mixed managed + external SELL ceiling
describe('F-6 SELL — mixed provenance ceiling', () => {
  it('caps SELL at X + Y, never exceeding managed quantity', () => {
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    expect(p.position(B)!.quantity.toFixed(8)).toBe('0.35000000');
    // An over-large SELL target is clamped to the 0.35 managed ceiling.
    const d = risk().evaluate(
      ctx('SELL', {
        currentPosition: p.position(B)!.quantity,
        externalPosition: p.external(B),
        sellTarget: { notional: Money.fromString('100000') },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.35000000');
  });
});

// TEST 8 — Reconciliation after authorization
describe('F-6 reconciliation after authorization', () => {
  it('expectedAssetBalances exactly equals managed + remaining external ownership', () => {
    // BOT 0.10 + external 0.25 -> after auth, expected must be 0.35 (all managed).
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const expected = p.expectedAssetBalances();
    expect(expected.get(BTC)!.toFixed(8)).toBe('0.35000000');
    // Quote currency is never an asset expectation.
    expect(expected.has('CAD')).toBe(false);
    // Unauthorized external for a DIFFERENT symbol remains separate.
    const p2 = seed('100000')
      .withExternalSnapshot(new Map([[B, Money.fromString('0.2')], ['ETH/CAD', Money.fromString('1.0')]]))
      .authorizeExternal(B);
    expect(p2.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe('0.20000000');
    expect(p2.expectedAssetBalances().get('ETH')!.toFixed(8)).toBe('1.00000000');
    expect(p2.position('ETH/CAD')).toBeNull();
  });
});

// TEST 9 — Persistence
describe('F-6 persistence across restart', () => {
  it('round-trips mixed ownership and quantities through serialize/deserialize', () => {
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    const pos = restored.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    expect(restored.external(B).isZero()).toBe(true);
    expect(restored.isAuthorizedExternal(B)).toBe(true);
    expect(restored.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe('0.35000000');
  });

  it('preserves per-source provenance across a serialize/deserialize round-trip', () => {
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    const pos = restored.position(B)!;
    expect(pos.source).toBe('BOT'); // BOT identity preserved, not reclassified
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
  });
});

// TEST 10 — Source/provenance
describe('F-6 source provenance on a mixed position', () => {
  it('does NOT reclassify existing BOT inventory as external-authorized', () => {
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B);
    const pos = p.position(B)!;
    // BOT inventory stays BOT at the source-quantity level.
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.10000000');
    // The newly-authored external is separately recorded.
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.25000000');
    // Sum of provenance equals the aggregate quantity (no lost/duplicate accounting).
    const total = pos.sourceQuantities.BOT.add(pos.sourceQuantities.EXTERNAL_AUTHORIZED);
    expect(total.equals(pos.quantity)).toBe(true);
  });

  it('a pure external authorization has all provenance in EXTERNAL_AUTHORIZED', () => {
    const p = seed('100000').withExternalSnapshot(new Map([[B, Money.fromString('0.5')]])).authorizeExternal(B);
    const pos = p.position(B)!;
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.50000000');
    expect(pos.sourceQuantities.BOT.isZero()).toBe(true);
  });

  it('partial SELL keeps the provenance breakdown summing exactly to the remaining quantity', () => {
    // Mixed 0.35 (BOT 0.10 + EXTERNAL_AUTHORIZED 0.25); sell 0.15, BOT-first.
    const p = seed('100000')
      .applyFill(B, 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.zero())
      .withExternalSnapshot(new Map([[B, Money.fromString('0.25')]]))
      .authorizeExternal(B)
      .applyFill(B, 'SELL', Money.fromString('0.15'), Money.fromString('40000'), Money.zero());
    const pos = p.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.20000000');
    // Sell order consumes BOT first (0.10) then EXTERNAL_AUTHORIZED (0.05).
    expect(pos.sourceQuantities.BOT.isZero()).toBe(true);
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.20000000');
    const total = pos.sourceQuantities.BOT.add(pos.sourceQuantities.EXTERNAL_AUTHORIZED);
    expect(total.equals(pos.quantity)).toBe(true);
  });
});

// Backward compatibility: persisted state written before sourceQuantities
describe('F-6 persistence — legacy state without sourceQuantities', () => {
  it('derives provenance from source and remains ownership-correct', () => {
    const legacy: PortfolioJsonV1 = {
      version: 1,
      cash: { CAD: '99000.00000000', BTC: '0.00000000' },
      positions: {
        'BTC/CAD': {
          symbol: 'BTC/CAD',
          quantity: '0.35000000',
          averageEntryPrice: '11428.57142857',
          costBasis: '4000.00000000',
          realizedPnl: '0.00000000',
          feesPaid: '0.00000000',
          source: 'BOT', // pre-5.5 file: no sourceQuantities field
        },
      },
      peakEquity: '103000.00000000',
      realizedPnl: '0.00000000',
      totalFees: '0.00000000',
    };
    const p = Portfolio.fromModel(deserializePortfolio(legacy));
    const pos = p.position(B)!;
    expect(pos.quantity.toFixed(8)).toBe('0.35000000');
    // Legacy BOT position derives its full quantity as BOT provenance.
    expect(pos.source).toBe('BOT');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.35000000');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.isZero()).toBe(true);
    // Reconciling a pure-BOT aggregate still equals the exchange expectation.
    expect(p.expectedAssetBalances().get(BTC)!.toFixed(8)).toBe('0.35000000');
  });
});
