/**
 * P2 — candle-series freshness in the decision path.
 *
 * The MarketCoordinator must skip a market whose COMPLETED candle series has
 * aged out (independent of ticker/quote freshness) when a positive
 * `candleMaxAgeMs` is configured. It preserves legacy behaviour when no bound is
 * configured (direct constructions).
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { FreshnessPolicy } from '../../../src/marketdata/freshness.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import type { Signal } from '../../../src/strategy/Signal.js';
import { signal } from '../../../src/strategy/Signal.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../../../src/types.js';

const TW: Timeframe = '5m';
const NOW = 1_000_000;
const BAR = 300_000;

const riskConfig: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 0.5,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 10,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

const freshnessPolicy: FreshnessPolicy = {
  maxQuoteAgeMs: 60_000,
  maxTransportAgeMs: 60_000,
  maxAcceptableFutureSkewMs: 120_000,
};

const market: MarketInfo = {
  symbol: 'BTC/CAD', exchangeId: '1', priceTick: Money.fromString('0.01'),
  basePrecision: 8, quotePrecision: 2, quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'), minOrderQuote: null,
  supportsMarketOrders: true, feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

const alwaysBuy: Strategy = {
  id: 'always-buy', name: 'always-buy', timeframe: TW, warmupCandles: 1,
  evaluate: (ctx: StrategyContext): Signal => signal(ctx.symbol, 'BUY', { reason: 'test' }, ctx.nowMs),
  describe: () => 'always-buy',
};

function ticker(ts: number): Ticker {
  const p = Money.fromString('100');
  return { symbol: 'BTC/CAD', bid: p, ask: p, last: p, open: null, high: null, low: null, baseVolume: null, quoteVolume: null, timestampMs: ts, observedAtMs: ts };
}

function candle(endMs: number): Candle {
  const p = Money.fromString('100');
  return { symbol: 'BTC/CAD', timeframe: TW, timestampMs: endMs, open: p, high: p, low: p, close: p, baseVolume: Money.zero() };
}

function build(candles: Candle[], candleMaxAgeMs?: number): MarketCoordinator {
  return new MarketCoordinator({
    strategy: alwaysBuy,
    riskManager: new RiskManager(riskConfig),
    getPortfolio: () => Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])),
    timeframe: TW,
    marketSource: {
      getMarketInfo: () => market,
      getTicker: () => ticker(NOW),
      getCandles: () => candles,
    },
    freshnessPolicy,
    ...(candleMaxAgeMs !== undefined ? { candleMaxAgeMs } : {}),
  });
}

describe('P2 — candle-series freshness enforced in the coordinator', () => {
  it('skips a stale candle series (no selection, STALE_CANDLES)', () => {
    const c = build([candle(NOW - 10 * BAR)], 3 * BAR);
    const r = c.evaluate(['BTC/CAD'], NOW);
    expect(r.selected).toBeNull();
    const e = r.evaluated[0]!;
    expect(e.skipped).toBe(true);
    expect(e.skipReason).toContain('STALE_CANDLES');
  });

  it('selects when the candle series is fresh', () => {
    const c = build([candle(NOW - BAR)], 3 * BAR);
    const r = c.evaluate(['BTC/CAD'], NOW);
    expect(r.selected?.symbol).toBe('BTC/CAD');
  });

  it('does not enforce when no bound is configured (legacy direct construction)', () => {
    const c = build([candle(NOW - 10 * BAR)]);
    const r = c.evaluate(['BTC/CAD'], NOW);
    expect(r.selected?.symbol).toBe('BTC/CAD');
  });
});
