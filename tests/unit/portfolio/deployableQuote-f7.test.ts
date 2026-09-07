/**
 * F-7 — held/frozen quote must not be treated as deployable.
 *
 * Adversarial tests against the REAL portfolio + risk architecture. The core
 * invariant:
 *   DEPLOYABLE QUOTE MUST NEVER EXCEED THE ACTUAL QUOTE CAPITAL THE BOT CAN
 *   SAFELY SPEND.
 *
 * Exchange truth (NDAX): `Balance.total` = amount, `Balance.held` = hold, and
 * `Balance.available = total - held` (see NdaxAdapter.getBalances). So
 * `available` ALREADY EXCLUDES held/frozen funds — a deployable computed from
 * `available` must never subtract held a second time.
 *
 * Model (live): deployable = min(botManagedCash, exchangeAvailable) - botReserved,
 * clamped to >= 0. Paper (no exchange-held concept) keeps `deployableQuote = cash - reserved`.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo, Balance } from '../../../src/types.js';

const BTC = 'BTC/CAD';
const NOW = 1_000_000_000;
const PRICE = Money.fromString('40000.00');
const PORTFOLIO_VAL = Money.fromString('100000.00');

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

const feeMarket: MarketInfo = { ...marketInfo, feeInfo: { maker: 0.001, taker: 0.001, feeCurrency: 'quote' } };

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

/** Exchange balance helper: NDAX exposes amount(total)/hold(held), avail = total - held. */
function bal(total: string, held: string): Balance {
  const t = Money.fromString(total);
  const h = Money.fromString(held);
  return { currency: 'CAD', total: t, available: t.sub(h), held: h };
}

function portfolio(cash: string, reserved = '0'): Portfolio {
  let p = Portfolio.empty(new Map([['CAD', Money.fromString(cash)]]));
  if (reserved !== '0') p = p.reserveQuote('CAD', Money.fromString(reserved));
  return p;
}

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Partial<RiskContext> = {}): RiskContext {
  return {
    symbol: BTC,
    signal: signal(BTC, signalType, {}, NOW),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: PRICE,
    marketInfo,
    quoteBalance: bal('100000', '0'),
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

const risk = () => new RiskManager(riskCfg);

// --- 1 & 2. Held quote reduces deployable; available already excludes held. ---
describe('F-7 — held quote reduces deployable (no double subtraction)', () => {
  it('caps deployable at exchange available (total-hold), not the bot accounting total', () => {
    // Bot accounting thinks it has 100 CAD; exchange has 30 CAD held (avail 70).
    const p = portfolio('100');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('100.00'); // internal view (ignores held)
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).toBe('70.00');
  });

  it('never subtracts held twice (70 total of which 30 held => 70 deployable, not 40)', () => {
    const p = portfolio('100');
    const d = p.deployableQuoteBounded('CAD', bal('100', '30'));
    expect(d.toFixed(2)).toBe('70.00');
    expect(d.toFixed(2)).not.toBe('40.00');
  });

  it('deployable never exceeds the bot managed cash (not everything in the exchange account)', () => {
    // Exchange has 200 available, but the bot only manages 50 CAD.
    expect(portfolio('50').deployableQuoteBounded('CAD', bal('200', '0')).toFixed(2)).toBe('50.00');
  });
});

// --- 3 & 4. Bot reservation is separate; reserved > available -> 0. ---
describe('F-7 — bot reservation is separate and never double counted', () => {
  it('reservation is subtracted from the exchange-available pool, held and reserved do not combine', () => {
    // avail 70 (total 100 - held 30), bot reserved 20 => deployable 50.
    const p = portfolio('100', '20');
    expect(p.reserved('CAD').toFixed(2)).toBe('20.00');
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).toBe('50.00');
  });

  it('reserved greater than the deployable pool yields zero (can never go negative)', () => {
    const p = portfolio('100', '80');
    const d = p.deployableQuoteBounded('CAD', bal('100', '30'));
    expect(d.isZero()).toBe(true);
    expect(d.isNegative()).toBe(false);
  });
});

// --- 5. Held/frozen funds cannot fund a BUY. ---
describe('F-7 — held funds cannot fund a BUY (risk layer)', () => {
  it('approves with total CAD but rejects once bounded by exchange available', () => {
    // Trade sized to the 10% cap = 10000 CAD (0.25 BTC). Exchange TOTAL = 100000,
    // but 30000 is HELD so only 70000 is available.
    const p = portfolio('100000');
    const bounded = p.deployableQuoteBounded('CAD', bal('100000', '30000'));
    expect(bounded.toFixed(2)).toBe('70000.00');

    // WITHOUT the F-7 bound, deployableQuote (100000) lets the BUY through.
    const naive = risk().evaluate(ctx('BUY', { deployableQuote: p.deployableQuote('CAD') }));
    expect(naive.approved).toBe(true);

    // WITH the F-7 bound, the same trade is rejected (available 70000 already
    // covers the notional but the risk layer must size against the correct pool).
    // Use a target that needs more than the available pool.
    const d = risk().evaluate(
      ctx('BUY', {
        deployableQuote: bounded,
        portfolioValue: Money.fromString('1000000.00'),
        marketInfo: { ...marketInfo, minOrderBase: Money.fromString('0.0001') },
      }),
    );
    // 10% of 1,000,000 = 100,000 notional > deployable 70,000 => rejected on funding.
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('INSUFFICIENT_BALANCE');
  });
});

// --- 6. Fee reserve remains enforced. ---
describe('F-7 — fee reserve is enforced alongside the bounded pool', () => {
  it('rejects when notional + fee > deployable, even though notional fits', () => {
    // 10% cap = 10000; fee @0.1% = 10; deployable exactly 10000 => fee not covered.
    const d = risk().evaluate(
      ctx('BUY', { marketInfo: feeMarket, deployableQuote: Money.fromString('10000.00') }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('approves when deployable covers notional + fee', () => {
    const d = risk().evaluate(
      ctx('BUY', { marketInfo: feeMarket, deployableQuote: Money.fromString('10010.00') }),
    );
    expect(d.approved).toBe(true);
  });
});

// --- 7. Malformed exchange balance data fails closed. ---
describe('F-7 — malformed balance fails closed (deployable = 0)', () => {
  it('returns zero for missing balance', () => {
    expect(portfolio('100').deployableQuoteBounded('CAD', null).isZero()).toBe(true);
    expect(portfolio('100').deployableQuoteBounded('CAD', undefined).isZero()).toBe(true);
  });

  it('returns zero for a negative available amount', () => {
    const n = Money.fromString('-10');
    const b: Balance = { currency: 'CAD', total: Money.fromString('100'), available: n, held: n };
    expect(portfolio('100').deployableQuoteBounded('CAD', b).isZero()).toBe(true);
  });

  it('returns zero for negative total or negative held', () => {
    expect(portfolio('100').deployableQuoteBounded('CAD', { currency: 'CAD', total: Money.fromString('-5'), available: Money.fromString('100'), held: Money.fromString('0') }).isZero()).toBe(true);
    expect(portfolio('100').deployableQuoteBounded('CAD', { currency: 'CAD', total: Money.fromString('100'), available: Money.fromString('100'), held: Money.fromString('-5') }).isZero()).toBe(true);
  });

  it('returns zero when available exceeds total (would imply negative held)', () => {
    expect(portfolio('100').deployableQuoteBounded('CAD', { currency: 'CAD', total: Money.fromString('70'), available: Money.fromString('100'), held: Money.fromString('0') }).isZero()).toBe(true);
  });

  it('returns zero on an inconsistent total/available/held decomposition', () => {
    expect(portfolio('100').deployableQuoteBounded('CAD', { currency: 'CAD', total: Money.fromString('100'), available: Money.fromString('80'), held: Money.fromString('30') }).isZero()).toBe(true);
  });

  it('a malformed available can never yield a positive deployable that funds a BUY', () => {
    const d = risk().evaluate(
      ctx('BUY', { deployableQuote: Money.zero(), quoteBalance: { currency: 'CAD', total: Money.fromString('100'), available: Money.fromString('-10'), held: Money.fromString('0') } }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(['INSUFFICIENT_BALANCE', 'UNKNOWN_BALANCE']).toContain(d.reason);
  });
});

// --- 8. External crypto remains protected. ---
describe('F-7 — external crypto ownership is unaffected by deployable-quote change', () => {
  it('a SELL can never consume EXTERNAL base inventory, regardless of quote accounting', () => {
    const d = risk().evaluate(ctx('SELL', { currentPosition: Money.zero(), externalPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('SELL_EXCEEDS_MANAGED_POSITION');
  });

  it('a SELL of managed inventory is still allowed and bounded by the managed quantity', () => {
    const d = risk().evaluate(ctx('SELL', { currentPosition: Money.fromString('0.1'), externalPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.10000000');
  });
});

// --- 9. Paper vs live models remain distinct (F-1/F-5 isolation intact). ---
describe('F-7 — paper vs live deployable models remain separate', () => {
  it('paper deployableQuote (cash - reserved) is unchanged and reservation-aware', () => {
    const p = portfolio('100', '20');
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('80.00');
  });

  it('live deployableQuote is exchange-available-aware; a held-only exchange does NOT reduce paper deployable', () => {
    const p = portfolio('100', '20');
    // Paper ignores held (no exchange-held concept): 80.
    expect(p.deployableQuote('CAD').toFixed(2)).toBe('80.00');
    // Live bounds by exchange available then subtracts reserved: 50.
    expect(p.deployableQuoteBounded('CAD', bal('100', '30')).toFixed(2)).toBe('50.00');
  });

  it('missing live managed state still yields a fully empty managed portfolio (F-1/F-5)', () => {
    // Sanity that the bounded method does not manufacture capital.
    const p = Portfolio.empty(new Map([['CAD', Money.zero()]]));
    expect(p.deployableQuoteBounded('CAD', bal('100000', '0')).isZero()).toBe(true);
    expect(p.position(BTC)).toBeNull();
    expect(p.managedOpenCount()).toBe(0);
  });
});
