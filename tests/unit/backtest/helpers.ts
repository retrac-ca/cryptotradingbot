/**
 * Shared test helpers for the Backtesting V1 suite.
 */

import { Money } from '../../../src/money/Money.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig, RiskDecision, AppliedRiskLimits } from '../../../src/risk/index.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import type { BacktestConfig } from '../../../src/backtest/types.js';
import type { Candle, Timeframe } from '../../../src/types.js';

export const SYMBOL = 'BTC/CAD';
export const QUOTE = 'CAD';
export const TF: Timeframe = '1d';

/** Doji candle by default (open === close) so next-open fills are exact. */
export function candle(i: number, close: number, open?: number): Candle {
  const o = open ?? close;
  const hi = Math.max(o, close);
  const lo = Math.min(o, close);
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: 1_700_000_000_000 + i * 86_400_000,
    open: Money.fromNumber(o),
    high: Money.fromNumber(hi * 1.02),
    low: Money.fromNumber(lo * 0.98),
    close: Money.fromNumber(close),
    baseVolume: Money.fromString('5'),
  };
}

export function flatSeries(n: number, close: number): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, close));
}

export function risingSeries(n: number, start = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, start + i));
}

export function fallingSeries(n: number, start = 200): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, start - i));
}

/** Falling-then-rising closes -> a golden-cross BUY on the real MA strategy. */
export function crossSeries(n = 30): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = i < 15 ? 200 - i * 2 : 170 + (i - 15) * 6;
    out.push(candle(i, close));
  }
  return out;
}

export function btConfig(over: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    initialCash: Money.fromNumber(10000),
    quoteCurrency: QUOTE,
    feeModel: { kind: 'rate', currency: 'quote', rate: 0 },
    slippageFraction: 0,
    marketConstraints: {
      priceTick: Money.fromString('0.01'),
      quantityTick: Money.fromString('0.00000001'),
      minOrderBase: null,
    },
    ...over,
  };
}

export const RISK_CFG: RiskConfig = {
  maxTradeAmount: Money.zero(),
  maxPositionSizeFraction: 1,
  maxPortfolioExposureFraction: 1,
  maxDailyLossFraction: 1,
  maxDrawdownFraction: 1,
  cooldownAfterLossMs: 0,
  maxOpenPositions: 0,
  marketDataMaxAgeMs: 1000,
  marketDataTransportMaxAgeMs: 1000,
  maxClockSkewMs: 1000,
};

export function appliedLimits(): AppliedRiskLimits {
  return {
    maxTradeAmount: Money.zero(),
    maxPositionSizeFraction: 1,
    maxPortfolioExposureFraction: 1,
    maxDailyLossFraction: 1,
    maxDrawdownFraction: 1,
    cooldownAfterLossMs: 0,
    maxOpenPositions: 0,
    killSwitchActive: false,
  };
}

export function approveBuy(quantity: Money, price: Money): RiskDecision {
  return {
    approved: true,
    symbol: SYMBOL,
    side: 'BUY',
    quantity,
    estimatedNotional: quantity.mul(price),
    price,
    reason: 'APPROVED',
    appliedLimits: appliedLimits(),
  };
}

export function approveSell(quantity: Money, price: Money): RiskDecision {
  return {
    approved: true,
    symbol: SYMBOL,
    side: 'SELL',
    quantity,
    estimatedNotional: quantity.mul(price),
    price,
    reason: 'APPROVED',
    appliedLimits: appliedLimits(),
  };
}

/** Stub RiskManager that returns a fixed decision, so quantities are controlled. */
export class StubRisk extends RiskManager {
  constructor(private readonly decide: (ctx: RiskContext) => RiskDecision) {
    super(RISK_CFG);
  }
  override evaluate(ctx: RiskContext): RiskDecision {
    return this.decide(ctx);
  }
}

/** Strategy scaffolding around a scripted signal sequence (consumed in order). */
export function stubStrategy(signals: ('BUY' | 'SELL' | 'HOLD')[], warmupCandles = 0): Strategy {
  let idx = 0;
  return {
    id: 'stub',
    name: 'stub',
    timeframe: TF,
    warmupCandles,
    evaluate: (_ctx: StrategyContext) => {
      const s = signals[idx] ?? 'HOLD';
      idx += 1;
      return signal(SYMBOL, s, { reason: 'stub' }, 0);
    },
    describe: () => 'stub',
  };
}
