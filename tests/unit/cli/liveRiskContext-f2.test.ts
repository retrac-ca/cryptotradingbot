/**
 * C-1 / H-1 — live risk-context portfolio-wide exposure (F-2) + freshness (F-8).
 *
 * Previously `buildLiveRiskContext` valued ONLY the candidate symbol, so a live
 * portfolio holding multiple managed positions would understate portfolioValue /
 * portfolioExposure (other positions silently omitted) — allowing a future BUY to
 * exceed maxPortfolioExposureFraction. The fix values EVERY managed position and
 * fails closed (null) if any non-candidate position has no fresh, market-specific
 * price (never treating an unavailable valuation as zero).
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { evaluateFreshness, type FreshnessPolicy } from '../../../src/marketdata/index.js';
import { buildLiveRiskContext, type LiveSnapshot } from '../../../src/cli/live-test-cmd.js';
import type { Balance, MarketInfo, Ticker } from '../../../src/types.js';

const NOW = 1_000_000;
const MAX_AGE = 60_000;

const freshPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: MAX_AGE,
  maxTransportAgeMs: MAX_AGE,
  maxAcceptableFutureSkewMs: 120_000,
};

const riskCfg: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.5,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 10,
  marketDataMaxAgeMs: MAX_AGE,
  marketDataTransportMaxAgeMs: MAX_AGE,
  maxClockSkewMs: 120_000,
};

function mid(symbol: string): MarketInfo {
  return {
    symbol, exchangeId: '1', priceTick: Money.fromString('0.01'),
    basePrecision: 8, quotePrecision: 2, quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.fromString('0.00000001'), minOrderQuote: null,
    supportsMarketOrders: true, feeInfo: { maker: 0.0005, taker: 0.0005, feeCurrency: 'quote' },
  };
}

function ticker(symbol: string, price: string, ts = NOW): Ticker {
  const p = Money.fromString(price);
  return { symbol, bid: p, ask: p, last: p, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs: ts, observedAtMs: ts };
}

function snapshotFor(symbol: string, price: string, ts = NOW): LiveSnapshot {
  const t = ticker(symbol, price, ts);
  const bal: Balance[] = [
    { currency: 'CAD', total: Money.fromString('880'), available: Money.fromString('880'), held: Money.zero() },
    { currency: symbol.split('/')[0]!, total: Money.fromString('0.001'), available: Money.fromString('0.001'), held: Money.zero() },
  ];
  return {
    symbol, ticker: t, bookQuoteTs: null, market: mid(symbol), balances: bal,
    observedAtMs: ts, quoteTs: ts,
    freshness: evaluateFreshness({ nowMs: ts, quoteTimestampMs: t.timestampMs, observedAtMs: ts, policy: freshPolicy }),
  };
}

// Portfolio: cash 810, BOT ETH 0.05@3000 (cost 150), BOT BTC 0.001@40000 (cost 40).
function twoPosition(): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]))
    .applyFill('ETH/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('3000'), Money.zero())
    .applyFill('BTC/CAD', 'BUY', Money.fromString('0.001'), Money.fromString('40000'), Money.zero());
}

describe('C-1 — live risk-context values the WHOLE managed portfolio', () => {
  it('includes ALL managed positions (candidate + non-candidate) in value & exposure', () => {
    const p = twoPosition();
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'BTC/CAD',
      side: 'SELL',
      reason: 'test',
      // Fresh ETH price for the NON-candidate managed position.
      managedValuation: new Map([['ETH/CAD', ticker('ETH/CAD', '3000')]]),
      freshnessPolicy: freshPolicy,
    });
    // equity = 810 + 0.001*40000 + 0.05*3000 = 810 + 40 + 150 = 1000.
    expect(ctx.portfolioValue!.toFixed(2)).toBe('1000.00');
    // exposure = ETH 150 + BTC 40 = 190 (NOT just the candidate's 40).
    expect(ctx.portfolioExposure!.toFixed(2)).toBe('190.00');
  });

  it('a missing non-candidate price fails closed (portfolioValue/exposure = null)', () => {
    const p = twoPosition();
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'BTC/CAD',
      side: 'SELL',
      reason: 'test',
      managedValuation: new Map(), // no ETH/CAD price
      freshnessPolicy: freshPolicy,
    });
    expect(ctx.portfolioValue).toBeNull();
    expect(ctx.portfolioExposure).toBeNull();
  });

  it('a stale non-candidate price fails closed (never trusts an old managed valuation)', () => {
    const p = twoPosition();
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'BTC/CAD',
      side: 'SELL',
      reason: 'test',
      managedValuation: new Map([['ETH/CAD', ticker('ETH/CAD', '3000', NOW - 200_000)]]), // stale
      freshnessPolicy: freshPolicy,
    });
    expect(ctx.portfolioValue).toBeNull();
    expect(ctx.portfolioExposure).toBeNull();
  });

  it('market isolation: a BTC ticker cannot value an ETH position (required market-specific price)', () => {
    const p = twoPosition();
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'BTC/CAD',
      side: 'SELL',
      reason: 'test',
      // Only BTC/CAD value provided; the ETH position is NOT in the map.
      managedValuation: new Map([['BTC/CAD', ticker('BTC/CAD', '41000')]]),
      freshnessPolicy: freshPolicy,
    });
    // ETH is a managed position without its own price -> unknown, not valued at BTC.
    expect(ctx.portfolioValue).toBeNull();
    expect(ctx.portfolioExposure).toBeNull();
  });

  it('a single-position portfolio (candidate only) still values correctly (no regression)', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.001'), Money.fromString('40000'), Money.zero());
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'BTC/CAD',
      side: 'SELL',
      reason: 'test',
      managedValuation: new Map(),
      freshnessPolicy: freshPolicy,
    });
    expect(ctx.portfolioValue!.toFixed(2)).toBe('1000.00'); // 960 cash + 40 BTC
    expect(ctx.portfolioExposure!.toFixed(2)).toBe('40.00');
  });

  it('a missing non-candidate price makes a BUY fail closed in RiskManager', () => {
    const p = twoPosition();
    const ctx = buildLiveRiskContext({
      snapshot: snapshotFor('BTC/CAD', '40000'),
      portfolio: p,
      symbol: 'ETH/CAD', // BUY candidate ETH (has a position)
      side: 'BUY',
      reason: 'test',
      managedValuation: new Map(), // no BTC/CAD price -> ETH valuation unknown
      freshnessPolicy: freshPolicy,
    });
    const d = new RiskManager(riskCfg).evaluate(ctx);
    expect(d.approved).toBe(false);
    if (!d.approved) expect(['UNKNOWN_PORTFOLIO_VALUE', 'UNKNOWN_EXPOSURE']).toContain(d.reason);
  });

  it('candidate executable price semantics are unchanged (BUY ask??last, SELL bid??last)', () => {
    const p = Portfolio.empty(new Map([['CAD', Money.fromString('1000')]]));
    const snap = snapshotFor('BTC/CAD', '40000');
    snap.ticker = { ...snap.ticker, bid: Money.fromString('40000'), ask: Money.fromString('40001'), last: Money.fromString('40000') };
    for (const side of ['BUY', 'SELL'] as const) {
      const ctx = buildLiveRiskContext({
        snapshot: snap, portfolio: p, symbol: 'BTC/CAD', side, reason: 'test',
        managedValuation: new Map(), freshnessPolicy: freshPolicy,
      });
      // BUY uses the ask (40001), SELL uses the bid (40000).
      expect(ctx.price!.toFixed(2)).toBe(side === 'BUY' ? '40001.00' : '40000.00');
    }
  });
});
