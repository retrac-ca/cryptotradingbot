/**
 * Backtesting V1 — deterministic engine tests.
 *
 * Covers fresh-state isolation, the C1 event ordering (no lookahead), the
 * fill/slippage/tick model, execution-time safety, risk-once semantics,
 * determinism, and structural isolation from live/paper/manual state.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { runBacktest, computeFillPrice } from '../../../src/backtest/index.js';
import { buildStrategy } from '../../../src/strategy/index.js';
import { buildRiskManager } from '../../../src/risk/index.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { BacktestConfig } from '../../../src/backtest/types.js';
import type { Strategy } from '../../../src/strategy/Strategy.js';
import type { RiskManager } from '../../../src/risk/RiskManager.js';
import { btConfig, candle, flatSeries, stubStrategy, StubRisk, approveBuy, approveSell, SYMBOL, TF } from './helpers.js';

function run(
  candles: ReturnType<typeof flatSeries>,
  config: BacktestConfig = btConfig(),
  createStrategy: () => Strategy = () => stubStrategy(['HOLD']),
  createRiskManager: () => RiskManager = () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100'))),
) {
  return runBacktest({ candles, config, createStrategy, createRiskManager });
}

describe('Backtesting V1 — fresh-state isolation', () => {
  it('identical inputs yield structurally identical results', () => {
    const candles = crossSeriesHelper();
    const a = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100'))));
    const b = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100'))));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reusing the same factories across runs does not leak state', () => {
    const candles = flatSeries(5, 100);
    const factory = () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD']);
    const riskFactory = () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100')));
    const a = run(candles, btConfig(), factory, riskFactory);
    const b = run(candles, btConfig(), factory, riskFactory);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('strategy factory is called exactly once per run', () => {
    let calls = 0;
    run(flatSeries(5, 100), btConfig(), () => {
      calls += 1;
      return stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD']);
    });
    expect(calls).toBe(1);
  });

  it('risk factory is called exactly once per run', () => {
    let calls = 0;
    run(flatSeries(5, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), () => {
      calls += 1;
      return new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100')));
    });
    expect(calls).toBe(1);
  });

  it('a prior losing run cannot contaminate a later run', () => {
    // A run that ends in a loss (BUY then SELL at a lower price).
    const losing = run(flatSeries(3, 100), btConfig(), () => stubStrategy(['BUY', 'SELL', 'HOLD']), () => new StubRisk((ctx) => (ctx.signal.type === 'BUY' ? approveBuy(Money.fromString('1'), Money.fromString('100')) : approveSell(Money.fromString('1'), Money.fromString('100')))));
    // A second, independent run with identical inputs must be byte-identical.
    const again = run(flatSeries(3, 100), btConfig(), () => stubStrategy(['BUY', 'SELL', 'HOLD']), () => new StubRisk((ctx) => (ctx.signal.type === 'BUY' ? approveBuy(Money.fromString('1'), Money.fromString('100')) : approveSell(Money.fromString('1'), Money.fromString('100')))));
    expect(JSON.stringify(losing)).toBe(JSON.stringify(again));
  });

  it('a real stateful strategy is deterministic across runs (no crossState leak)', () => {
    const candles = crossSeriesHelper();
    const botCfg = botConfig();
    const a = run(candles, btConfig({ feeModel: { kind: 'rate', currency: 'quote', rate: 0.002 } }), () => buildStrategy(botCfg), () => buildRiskManager(botCfg));
    const b = run(candles, btConfig({ feeModel: { kind: 'rate', currency: 'quote', rate: 0.002 } }), () => buildStrategy(botCfg), () => buildRiskManager(botCfg));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

function crossSeriesHelper() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const close = i < 15 ? 200 - i * 2 : 170 + (i - 15) * 6;
    out.push(candle(i, close));
  }
  return out;
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

describe('Backtesting V1 — C1 event ordering (no lookahead)', () => {
  it('a close[i] signal never fills at close[i]; it fills at the next bar open', () => {
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']));
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0]!;
    expect(t.signalBarIndex).toBe(0); // decision at close[0]
    expect(t.barIndex).toBe(1); // fill at open[1]
    expect(t.barIndex).toBeGreaterThan(t.signalBarIndex);
    expect(t.price.toString()).toBe('100.00000000'); // next bar open, no slippage
  });

  it('the strategy decision window is exactly candles[0..i] (no future candle)', () => {
    const lengths: number[] = [];
    const recording: Strategy = {
      id: 'rec',
      name: 'rec',
      timeframe: TF,
      warmupCandles: 0,
      evaluate: (ctx) => {
        lengths.push(ctx.candles.length);
        return { symbol: SYMBOL, type: 'HOLD', timestampMs: ctx.nowMs };
      },
      describe: () => 'rec',
    };
    run(flatSeries(5, 100), btConfig(), () => recording);
    expect(lengths).toEqual([1, 2, 3, 4, 5]);
  });

  it('a future candle move cannot affect the current decision', () => {
    // A recording strategy that proves it only ever sees bars up to i.
    const seen: number[] = [];
    const strategy: Strategy = {
      id: 's',
      name: 's',
      timeframe: TF,
      warmupCandles: 0,
      evaluate: (ctx) => {
        seen.push(ctx.candles[ctx.candles.length - 1]!.timestampMs);
        return { symbol: SYMBOL, type: 'HOLD', timestampMs: ctx.nowMs };
      },
      describe: () => 's',
    };
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100)];
    run(candles, btConfig(), () => strategy);
    expect(seen).toEqual([candles[0]!.timestampMs, candles[1]!.timestampMs, candles[2]!.timestampMs]);
  });

  it('gaps do not synthesize candles or prices; the fill uses the next present bar', () => {
    // timestamp gap: bars at index 0, 1, 2 but with a missing bar time between 0 and 1.
    const c0 = candle(0, 100);
    const c1 = { ...candle(2, 100), timestampMs: candle(0, 100).timestampMs + 2 * 86_400_000 };
    const c2 = { ...candle(3, 100), timestampMs: c1.timestampMs + 86_400_000 };
    const candles = [c0, c1, c2];
    const result = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD']));
    expect(result.trades).toHaveLength(1);
    const t = result.trades[0]!;
    expect(t.signalBarIndex).toBe(0);
    expect(t.barIndex).toBe(1); // the next PRESENT bar
    expect(t.price.toString()).toBe('100.00000000'); // the real next open, not a synthesized price
  });

  it('decision timestamp equals close[i] (candle END time)', () => {
    const candles = flatSeries(3, 100);
    const result = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD']));
    // equity curve timestamps are the candle END times.
    expect(result.equityCurve.map((p) => p.timestampMs)).toEqual(candles.map((c) => c.timestampMs));
    expect(result.dataStartMs).toBe(candles[0]!.timestampMs);
    expect(result.dataEndMs).toBe(candles[candles.length - 1]!.timestampMs);
  });
});

describe('Backtesting V1 — fill model', () => {
  it('BUY applies slippage up and rounds UP to the price tick', () => {
    // open 100.123, priceTick 0.01, slippage 0 -> raw 100.123 -> ceil to 100.13
    const p = computeFillPrice(Money.fromString('100.123'), 'BUY', 0, Money.fromString('0.01'));
    expect(p.toString()).toBe('100.13000000');
  });

  it('SELL applies slippage down and rounds DOWN to the price tick', () => {
    const p = computeFillPrice(Money.fromString('100.123'), 'SELL', 0, Money.fromString('0.01'));
    expect(p.toString()).toBe('100.12000000');
  });

  it('BUY slippage increases the fill price', () => {
    const p = computeFillPrice(Money.fromString('100'), 'BUY', 0.01, Money.fromString('0.01'));
    expect(p.toString()).toBe('101.00000000');
  });

  it('SELL slippage decreases the fill price', () => {
    const p = computeFillPrice(Money.fromString('100'), 'SELL', 0.01, Money.fromString('0.01'));
    expect(p.toString()).toBe('99.00000000');
  });

  it('a quantity off the quantity tick is rejected at execution', () => {
    const config = btConfig({ marketConstraints: { priceTick: Money.fromString('0.01'), quantityTick: Money.fromString('0.01'), minOrderBase: null } });
    const result = run(flatSeries(3, 100), config, () => stubStrategy(['BUY', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('0.123'), Money.fromString('100'))));
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('PRECISION_VIOLATION');
    expect(result.rejections[0]!.phase).toBe('execution');
  });

  it('a quantity below minOrderBase is rejected at execution', () => {
    const config = btConfig({ marketConstraints: { priceTick: Money.fromString('0.01'), quantityTick: Money.fromString('0.00000001'), minOrderBase: Money.fromString('1') } });
    const result = run(flatSeries(3, 100), config, () => stubStrategy(['BUY', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('0.5'), Money.fromString('100'))));
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('BELOW_MIN_QUANTITY');
  });

  it('no partial fills: a fill executes the full approved quantity', () => {
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('2.5'), Money.fromString('100'))));
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.quantity.toString()).toBe('2.50000000');
  });

  it('a zero/negative quantity is rejected at execution', () => {
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.zero(), Money.fromString('100'))));
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('INVALID_QUANTITY');
  });
});

describe('Backtesting V1 — execution-time safety / accounting', () => {
  it('a SELL larger than the held position is rejected (cannot short)', () => {
    const result = run(flatSeries(3, 100), btConfig(), () => stubStrategy(['SELL', 'HOLD', 'HOLD']), () => new StubRisk(() => approveSell(Money.fromString('5'), Money.fromString('100'))));
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('SELL_EXCEEDS_POSITION');
    expect(result.finalQuoteCash.toString()).toBe('10000.00000000');
  });

  it('execution rejection leaves the Portfolio unchanged (exact Money)', () => {
    const after = run(flatSeries(4, 100), btConfig({ initialCash: Money.fromString('1000') }), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('10.00000001'), Money.fromString('100'))));
    expect(after.trades).toHaveLength(0);
    expect(after.finalQuoteCash.toString()).toBe('1000.00000000');
    expect(after.finalPositionQty.toFixed(8)).toBe('0.00000000');
  });

  it('the approved quantity is immutable: never silently resized', () => {
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('2.5'), Money.fromString('100'))));
    expect(result.trades[0]!.quantity.toString()).toBe('2.50000000');
  });

  it('a changed next-open price can reject but cannot resize', () => {
    // BUY approved at close[0]=100 with qty 9.95; next open is 120 (gap up) with slip -> cost > cash -> reject.
    const c0 = candle(0, 100);
    const c1 = { ...candle(1, 120), open: Money.fromNumber(120) };
    const c2 = candle(2, 120);
    const result = run([c0, c1, c2], btConfig({ initialCash: Money.fromString('1000'), slippageFraction: 0.01 }), () => stubStrategy(['BUY', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('9.95'), Money.fromString('100'))));
    expect(result.trades).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('INSUFFICIENT_BALANCE_AFTER_SLIPPAGE');
  });
});

describe('Backtesting V1 — RiskManager called once, immutable pending intent', () => {
  it('risk is evaluated exactly once per non-HOLD signal', () => {
    let riskCalls = 0;
    const risk = () => new StubRisk(() => {
      riskCalls += 1;
      return approveBuy(Money.fromString('1'), Money.fromString('100'));
    });
    run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), risk);
    expect(riskCalls).toBe(1);
  });

  it('execution does not re-run RiskManager', () => {
    let riskCalls = 0;
    const risk = () => new StubRisk(() => {
      riskCalls += 1;
      return approveBuy(Money.fromString('1'), Money.fromString('100'));
    });
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), risk);
    expect(result.trades).toHaveLength(1); // a fill DID happen
    expect(riskCalls).toBe(1); // but risk ran exactly once, never again at fill time
  });

  it('a risk rejection records a decision-phase rejection and creates no pending order', () => {
    const rejecting = () => new StubRisk(() => ({ approved: false, symbol: SYMBOL, side: 'BUY', reason: 'MAX_POSITION_EXCEEDED', appliedLimits: { maxTradeAmount: Money.zero(), maxPositionSizeFraction: 1, maxPortfolioExposureFraction: 1, maxDailyLossFraction: 1, maxDrawdownFraction: 1, cooldownAfterLossMs: 0, maxOpenPositions: 0, killSwitchActive: false } }));
    const result = run(flatSeries(4, 100), btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD']), rejecting);
    expect(result.trades).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]!.phase).toBe('decision');
    expect(result.rejections[0]!.reason).toBe('MAX_POSITION_EXCEEDED');
  });
});

describe('Backtesting V1 — determinism & structural isolation', () => {
  it('trade ids are deterministic across identical runs', () => {
    const candles = crossSeriesHelper();
    const idsA = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100')))).trades.map((t) => t.id);
    const idsB = run(candles, btConfig(), () => stubStrategy(['BUY', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), () => new StubRisk(() => approveBuy(Money.fromString('1'), Money.fromString('100')))).trades.map((t) => t.id);
    expect(idsA).toEqual(idsB);
    expect(idsA[0]).toMatch(/^bt-BTC\/CAD-\d+-\d+-BUY$/);
  });

  it('the engine source has no wall-clock, randomness, or network dependency', () => {
    const src = readFileSync(new URL('../../../src/backtest/engine.ts', import.meta.url), 'utf8');
    for (const forbidden of ['Date.now', 'randomUUID', 'Math.random', 'fetch(', 'axios', 'http']) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('the engine does not import live/manual/paper/exchange/persistence modules', () => {
    const src = readFileSync(new URL('../../../src/backtest/engine.ts', import.meta.url), 'utf8');
    for (const forbidden of ['../exchanges/', '../manual/', '../persistence/', '../execution/PaperExecutionEngine', '../engine/PaperEngine', 'ManagedStateStore']) {
      expect(src).not.toContain(forbidden);
    }
  });
});
