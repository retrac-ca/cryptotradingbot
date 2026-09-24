/**
 * F7 — live/paper strategy decisions must see COMPLETED candles only.
 *
 * `Candle.timestampMs` is the candle END time, so the currently-forming candle
 * has an end time in the future. The backtest already evaluates completed bars
 * only; these tests prove the live/paper decision path now matches it.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { completedCandles } from '../../../src/marketdata/candles.js';
import { MarketCoordinator } from '../../../src/engine/MarketCoordinator.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { Candle, MarketInfo, Timeframe } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';
const TF: Timeframe = '5m';

function candle(endMs: number): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: endMs,
    open: Money.fromString('100'),
    high: Money.fromString('100'),
    low: Money.fromString('100'),
    close: Money.fromString('100'),
    baseVolume: Money.fromString('1'),
  };
}

describe('F7 — completedCandles', () => {
  const now = 10_000_000;

  it('excludes a forming candle whose end time is in the future', () => {
    const completed = candle(now - 300_000);
    const forming = candle(now + 300_000);
    const out = completedCandles([completed, forming], now);
    expect(out).toEqual([completed]);
  });

  it('keeps the most recently completed candle', () => {
    const older = candle(now - 600_000);
    const latest = candle(now);
    const out = completedCandles([older, latest], now);
    expect(out).toEqual([older, latest]);
  });

  it('returns empty when every candle is still forming (safe HOLD downstream)', () => {
    expect(completedCandles([candle(now + 1)], now)).toEqual([]);
  });

  it('passes an empty series through unchanged', () => {
    expect(completedCandles([], now)).toEqual([]);
  });
});

describe('F7 — coordinator feeds only completed candles to the strategy', () => {
  it('the forming candle is not visible to the strategy', () => {
    const now = 10_000_000;
    const seen: number[] = [];
    const recording: Strategy = {
      id: 'rec',
      name: 'rec',
      timeframe: TF,
      warmupCandles: 0,
      evaluate: (ctx) => {
        seen.push(...ctx.candles.map((c) => c.timestampMs));
        return { symbol: SYMBOL, type: 'HOLD', timestampMs: ctx.nowMs };
      },
      describe: () => 'rec',
    };

    const riskCfg: RiskConfig = {
      maxTradeAmount: Money.zero(),
      maxPositionSizeFraction: 1,
      maxPortfolioExposureFraction: 1,
      maxDailyLossFraction: 1,
      maxDrawdownFraction: 1,
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

    const completed = candle(now - 300_000);
    const forming = candle(now + 300_000);

    const coordinator = new MarketCoordinator({
      strategy: recording,
      riskManager: new RiskManager(riskCfg),
      getPortfolio: () => Portfolio.empty(new Map([['CAD', Money.fromString('1000')]])),
      timeframe: TF,
      marketSource: {
        getMarketInfo: () => marketInfo,
        getTicker: () => null,
        getCandles: () => [completed, forming],
      },
      freshnessPolicy: { maxQuoteAgeMs: 60_000, maxTransportAgeMs: 60_000, maxAcceptableFutureSkewMs: 120_000 },
    });

    coordinator.evaluate([SYMBOL], now);
    expect(seen).toEqual([completed.timestampMs]);
    expect(seen).not.toContain(forming.timestampMs);
  });
});
