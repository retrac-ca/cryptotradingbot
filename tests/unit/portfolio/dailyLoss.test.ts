/**
 * F6 — real calendar-day (UTC) realized-P&L bucket.
 *
 * `maxDailyLossFraction` must use TODAY's realized P&L, not lifetime P&L, and
 * the bucket must survive a restart on the same day without rewriting lifetime
 * realized P&L.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { serializePortfolio, deserializePortfolio } from '../../../src/portfolio/serialization.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { MarketInfo, Timeframe } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '5m';
const DAY1 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY2 = Date.UTC(2026, 0, 2, 12, 0, 0);

/** A portfolio that took a 500-quote realized loss (10%) on DAY1. */
function portfolioWithLoss(): Portfolio {
  let p = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]));
  p = p.applyFill(SYMBOL, 'BUY', Money.fromString('50'), Money.fromString('100'), Money.zero(), DAY1);
  p = p.applyFill(SYMBOL, 'SELL', Money.fromString('50'), Money.fromString('90'), Money.zero(), DAY1);
  return p;
}

const riskCfg: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.5,
  maxPortfolioExposureFraction: 1,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.5,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 1,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

const marketInfo: MarketInfo = {
  symbol: SYMBOL,
  exchangeId: 'x',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 8,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: null,
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: null,
};

const buyStrategy: Strategy = {
  id: 'always-buy',
  name: 'always-buy',
  timeframe: TF,
  warmupCandles: 0,
  evaluate: (ctx) => ({ symbol: SYMBOL, type: 'BUY', timestampMs: ctx.nowMs }),
  describe: () => 'always-buy',
};

function coordinatorFor(portfolio: Portfolio, nowMs: number) {
  return new MarketCoordinator({
    strategy: buyStrategy,
    riskManager: new RiskManager(riskCfg),
    getPortfolio: () => portfolio,
    timeframe: TF,
    marketSource: {
      getMarketInfo: () => marketInfo,
      getTicker: () => ({
        symbol: SYMBOL,
        bid: Money.fromString('100'),
        ask: Money.fromString('100'),
        last: Money.fromString('100'),
        open: null,
        high: null,
        low: null,
        baseVolume: null,
        quoteVolume: null,
        timestampMs: nowMs,
        observedAtMs: nowMs,
      }),
      getCandles: () => [],
    },
    freshnessPolicy: { maxQuoteAgeMs: 60_000, maxTransportAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 },
  });
}

describe('F6 — daily realized P&L bucket', () => {
  it('accumulates the loss for the day of the fill', () => {
    const p = portfolioWithLoss();
    expect(p.dailyRealizedPnlAt(DAY1).toString()).toBe('-500.00000000');
    // Lifetime realized P&L is the same loss (unchanged by daily accounting).
    expect(p.stateModel.realizedPnl.toString()).toBe('-500.00000000');
  });

  it('a new day no longer counts the previous day toward today', () => {
    const p = portfolioWithLoss();
    expect(p.dailyRealizedPnlAt(DAY2).isZero()).toBe(true);
    // Lifetime P&L is untouched by the day boundary.
    expect(p.stateModel.realizedPnl.toString()).toBe('-500.00000000');
  });

  it('survives a restart on the same day (serialized bucket is preserved)', () => {
    const p = portfolioWithLoss();
    const restored = Portfolio.fromModel(deserializePortfolio(serializePortfolio(p.stateModel)));
    expect(restored.dailyRealizedPnlAt(DAY1).toString()).toBe('-500.00000000');
    expect(restored.stateModel.realizedPnl.toString()).toBe('-500.00000000');
  });

  it('blocks a BUY when TODAY\'s loss has breached the daily limit', () => {
    const p = portfolioWithLoss();
    const result = coordinatorFor(p, DAY1).evaluate([SYMBOL], DAY1);
    const decision = result.evaluated[0]!.decision!;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('DAILY_LOSS_LIMIT_EXCEEDED');
  });

  it('allows a BUY on a new day even though lifetime P&L is negative', () => {
    const p = portfolioWithLoss();
    const result = coordinatorFor(p, DAY2).evaluate([SYMBOL], DAY2);
    const decision = result.evaluated[0]!.decision!;
    expect(decision.approved).toBe(true);
    expect(result.selected?.side).toBe('BUY');
  });
});
