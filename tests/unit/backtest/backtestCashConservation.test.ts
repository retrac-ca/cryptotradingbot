/**
 * A1 — Backtest cash-conservation adversarial tests (Backtesting V1).
 *
 * A simulated BUY must NEVER cause backtest quote cash to become negative. Risk
 * sizes/funds a BUY at the decision (close) price, but the backtest fills at the
 * NEXT bar's OPEN with a slippage + fee. If that ACTUAL cost would exceed the
 * deployable quote, the simulated BUY is refused (recorded as an execution
 * rejection) rather than executing an unaffordable fill [A1]. Negative slippage
 * is rejected by config validation (fail closed), never silently allowed.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { runBacktest } from '../../../src/backtest/index.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { StrategyContext } from '../../../src/strategy/StrategyContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import { buildStrategy } from '../../../src/strategy/index.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { RiskConfig, RiskDecision, AppliedRiskLimits } from '../../../src/risk/index.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { BacktestConfig, BacktestResult } from '../../../src/backtest/types.js';
import type { Candle, Timeframe } from '../../../src/types.js';

const SYMBOL = 'BTC/CAD';
const QUOTE = 'CAD';
const TF: Timeframe = '1d';

/** Doji candle (open === close) so a next-open fill price is exact & controllable. */
function candle(i: number, close: number): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: 1_700_000_000_000 + i * 86_400_000,
    open: Money.fromNumber(close),
    high: Money.fromNumber(close * 1.02),
    low: Money.fromNumber(close * 0.98),
    close: Money.fromNumber(close),
    baseVolume: Money.fromString('5'),
  };
}

function flatSeries(n: number, close: number): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(i, close));
}

/** Constant-close + tiny ramp to force a golden-cross BUY on the real MA strategy. */
function crossSeries(): Candle[] {
  const out: Candle[] = [];
  const n = 30;
  for (let i = 0; i < n; i++) {
    const close = i < 15 ? 200 - i * 2 : 170 + (i - 15) * 6;
    out.push(candle(i, close));
  }
  return out;
}

function btConfig(over: Partial<BacktestConfig> = {}): BacktestConfig {
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

function botConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    tradingMode: 'paper',
    realFundsAtRisk: false,
    exchange: 'ndax',
    ndaxApiKey: '',
    ndaxApiSecret: '',
    ndaxUserId: '',
    ndaxUserName: '',
    enableAuthenticatedReads: false,
    tradingPairs: [SYMBOL],
    strategy: 'moving-average-crossover',
    timeframe: TF,
    maFastPeriod: 3,
    maSlowPeriod: 8,
    maxPositionSizeFraction: 0.998,
    maxTradeAmount: 0,
    stopLossFraction: 0.05,
    takeProfitFraction: 0.1,
    maxDailyLossFraction: 1,
    maxOpenPositions: 1,
    cooldownAfterLossSeconds: 0,
    maxPortfolioExposureFraction: 1,
    maxDrawdownFraction: 0.999,
    marketDataMaxAgeMs: 60000,
    marketDataTransportMaxAgeMs: 60000,
    maxClockSkewMs: 120000,
    paperStartingBalance: 10000,
    paperFeeFraction: 0.0005,
    paperSlippageFraction: 0,
    paperFillFraction: 1,
    paperStateFile: '.paper-state.json',
    orderLedgerFile: '.order-ledger.json',
    manualIntentFile: '.manual-intents.json',
    evaluateIntervalSeconds: 60,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    ...over,
  };
}

const RISK_CFG: RiskConfig = {
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

function appliedLimits(): AppliedRiskLimits {
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

function approveBuy(quantity: Money, price: Money): RiskDecision {
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

function approveSell(quantity: Money, price: Money): RiskDecision {
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

class StubRisk extends RiskManager {
  constructor(private readonly decide: (ctx: RiskContext) => RiskDecision) {
    super(RISK_CFG);
  }
  override evaluate(ctx: RiskContext): RiskDecision {
    return this.decide(ctx);
  }
}

/** Strategy scaffolding around a scripted signal sequence (consumed in order). */
function stubStrategy(signals: ('BUY' | 'SELL' | 'HOLD')[]): Strategy {
  let idx = 0;
  return {
    id: 'stub',
    name: 'stub',
    timeframe: TF,
    warmupCandles: 0,
    evaluate: (_ctx: StrategyContext) => {
      const s = signals[idx] ?? 'HOLD';
      idx += 1;
      return signal(SYMBOL, s, { reason: 'stub' }, 0);
    },
    describe: () => 'stub',
  };
}

function run(
  candles: Candle[],
  config: BacktestConfig,
  createStrategy: () => Strategy,
  createRiskManager: () => RiskManager,
): BacktestResult {
  return runBacktest({ candles, config, createStrategy, createRiskManager });
}

/** Replay BUY/SELL cash to assert the invariant holds across the whole run. */
function replayCash(result: BacktestResult): Money {
  let cash = result.config.initialCash;
  let minCash = cash;
  for (const t of result.trades) {
    if (t.side === 'BUY') cash = cash.sub(t.quantity.mul(t.price).add(t.fee));
    else cash = cash.add(t.quantity.mul(t.price).sub(t.fee));
    if (cash.compareTo(minCash) < 0) minCash = cash;
  }
  return minCash;
}

describe('A1 — Backtest BUY cash conservation', () => {
  it('an affordable-at-close BUY that becomes unaffordable after slippage is skipped, never overdraws', () => {
    // close=100 affordable at reference (no slip), but fill at next open=100 with
    // +1% slip -> 101 -> notional 9.95*101=1004.95 > 1000.
    const risk = new StubRisk(() => approveBuy(Money.fromString('9.95'), Money.fromString('100')));
    const result = run(flatSeries(2, 100), btConfig({ initialCash: Money.fromString('1000'), slippageFraction: 0.01 }), () => stubStrategy(['BUY', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(0);
    const a1 = result.rejections.filter((r) => r.reason === 'INSUFFICIENT_BALANCE_AFTER_SLIPPAGE');
    expect(a1).toHaveLength(1);
    expect(a1[0]!.side).toBe('BUY');
    expect(replayCash(result).isNegative()).toBe(false);
    expect(result.finalQuoteCash.isNegative()).toBe(false);
    expect(result.finalQuoteCash.toFixed(2)).toBe('1000.00');
    expect(result.finalPositionQty.toFixed(8)).toBe('0.00000000');
  });

  it('exact boundary: actualCost == deployableQuote is allowed and cash ends at 0', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('10'), Money.fromString('100')));
    const result = run(flatSeries(4, 100), btConfig({ initialCash: Money.fromString('1000') }), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.side).toBe('BUY');
    expect(result.rejections).toHaveLength(0);
    expect(result.finalQuoteCash.toString()).toBe('0.00000000');
    expect(result.finalQuoteCash.isNegative()).toBe(false);
    expect(result.finalPositionQty.toString()).toBe('10.00000000');
  });

  it('one smallest unit over boundary: rejected, no mutation', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('10.00000001'), Money.fromString('100')));
    const result = run(flatSeries(4, 100), btConfig({ initialCash: Money.fromString('1000') }), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.reason).toBe('INSUFFICIENT_BALANCE_AFTER_SLIPPAGE');
    expect(result.finalQuoteCash.toString()).toBe('1000.00000000');
    expect(result.finalPositionQty.toFixed(8)).toBe('0.00000000');
  });

  it('positive slippage IS included in affordability', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('9.8'), Money.fromString('100')));
    const result = run(flatSeries(2, 100), btConfig({ initialCash: Money.fromString('1000'), slippageFraction: 0.01 }), () => stubStrategy(['BUY', 'HOLD']), () => risk);
    // Fill at next open=100 -> raw 101 -> round up 101.00. 9.8*101=989.8 <= 1000.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.price.toString()).toBe('101.00000000');
    expect(result.finalQuoteCash.toString()).toBe('10.20000000');
    expect(result.finalPositionQty.toString()).toBe('9.80000000');
  });

  it('fee-only overrun: reference notional fits but fee pushes cost over deployable', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('9.9'), Money.fromString('100')));
    const result = run(flatSeries(2, 100), btConfig({ initialCash: Money.fromString('1000'), feeModel: { kind: 'rate', currency: 'quote', rate: 0.02 } }), () => stubStrategy(['BUY', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('INSUFFICIENT_BALANCE_AFTER_SLIPPAGE');
    expect(result.finalQuoteCash.toString()).toBe('1000.00000000');
  });

  it('exact Money conservation holds on a normal fill with fractional price/qty/fee', () => {
    const price = Money.fromString('123.456789');
    const qty = Money.fromString('7.89012345');
    const initialCash = Money.fromString('100000');
    const risk = new StubRisk(() => approveBuy(qty, price));
    const result = run(flatSeries(2, price.toNumber()), btConfig({ initialCash, slippageFraction: 0.0005 }), () => stubStrategy(['BUY', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0]!;
    // Cash conservation uses the ROUNDED tick fill price (stored on the trade).
    const cost = t.notional.add(t.fee);
    expect(initialCash.sub(cost).toString()).toBe(result.finalQuoteCash.toString());
    expect(result.finalQuoteCash.isNegative()).toBe(false);
    expect(result.finalPositionQty.toString()).toBe(qty.toString());
  });

  it('normal affordable BUY still executes exactly (no over-rejection)', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('5'), Money.fromString('100')));
    const result = run(flatSeries(2, 100), btConfig({ initialCash: Money.fromString('1000'), feeModel: { kind: 'rate', currency: 'quote', rate: 0.01 }, slippageFraction: 0.01 }), () => stubStrategy(['BUY', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(1);
    expect(result.rejections).toHaveLength(0);
    expect(result.trades[0]!.price.toString()).toBe('101.00000000');
    expect(result.finalQuoteCash.toString()).toBe('489.95000000');
    expect(result.finalQuoteCash.isNegative()).toBe(false);
  });

  it('negative slippage is REJECTED by config validation (fail closed, never silently allowed)', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('9.9'), Money.fromString('100')));
    expect(() =>
      run(flatSeries(2, 100), btConfig({ slippageFraction: -0.01 }), () => stubStrategy(['BUY', 'HOLD']), () => risk),
    ).toThrow(/slippageFraction/);
  });

  it('SELL is unaffected by the BUY guard and still credits quote', () => {
    const risk = new StubRisk((ctx) =>
      ctx.signal.type === 'BUY' ? approveBuy(Money.fromString('5'), Money.fromString('100')) : approveSell(Money.fromString('5'), Money.fromString('100')),
    );
    const result = run(flatSeries(3, 100), btConfig({ initialCash: Money.fromString('1000') }), () => stubStrategy(['BUY', 'SELL', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(2);
    expect(result.trades[1]!.side).toBe('SELL');
    expect(result.finalQuoteCash.toString()).toBe('1000.00000000');
    expect(result.finalPositionQty.toFixed(8)).toBe('0.00000000');
    expect(result.rejections).toHaveLength(0);
  });

  it('an unaffordable BUY leaves the portfolio clean so a subsequent affordable BUY executes', () => {
    const risk = new StubRisk(() => approveBuy(Money.fromString('9.95'), Money.fromString('100')));
    const result = run(flatSeries(3, 100), btConfig({ initialCash: Money.fromString('1000'), slippageFraction: 0.01 }), () => stubStrategy(['BUY', 'HOLD', 'HOLD']), () => risk);
    expect(result.trades).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.finalQuoteCash.toString()).toBe('1000.00000000');
    expect(result.finalPositionQty.toFixed(8)).toBe('0.00000000');
  });

  it('end-to-end (real strategy + risk) never drives cash negative', () => {
    const botCfg = botConfig();
    const result = run(
      crossSeries(),
      btConfig({ feeModel: { kind: 'rate', currency: 'quote', rate: 0.002 }, slippageFraction: 0.01 }),
      () => buildStrategy(botCfg),
      () => buildRiskManager(botCfg),
    );
    // No negative cash anywhere in the run.
    expect(replayCash(result).isNegative()).toBe(false);
    expect(result.finalQuoteCash.isNegative()).toBe(false);
  });

  it('reservations cannot exist in a backtest (portfolio is created flat), so deployable == cash', () => {
    const p = Portfolio.empty(new Map([[QUOTE, Money.fromString('1000')]]));
    expect(p.reserved(QUOTE).isZero()).toBe(true);
    expect(p.deployableQuote(QUOTE).toString()).toBe('1000.00000000');
  });
});
