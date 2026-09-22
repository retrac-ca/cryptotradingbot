/**
 * Trend–Pullback–Recovery (TPR) strategy — deterministic unit tests.
 *
 * All series are synthetic and deterministic (no live data). Small SMA / slope /
 * swing parameters are used so the crafted series stay readable; this is test
 * configuration, NOT a tuning of the pre-registered production defaults.
 *
 * The strategy is stateless, so every assertion is a pure function of the
 * supplied candles + PositionView.
 */

import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import {
  TrendPullbackRecoveryStrategy,
  DEFAULT_TPR_SMA_PERIOD,
  DEFAULT_TPR_SLOPE_LOOKBACK,
  DEFAULT_TPR_SWING_LOOKBACK,
  DEFAULT_TPR_MIN_PULLBACK_FRACTION,
  DEFAULT_TPR_PROFIT_TARGET_FRACTION,
  createStrategy,
} from '../../../src/strategy/index.js';
import type { StrategyContext, PositionView } from '../../../src/strategy/StrategyContext.js';
import type { Candle, Timeframe } from '../../../src/types.js';

const TF: Timeframe = '5m';
const SYMBOL = 'BTC/CAD';
const BASE_TS = 1_700_000_000_000;
const SCALE = 1_000_000_000n;

/** Test parameters (small periods keep the crafted series short). */
const PARAMS = {
  smaPeriod: 10,
  slopeLookback: 3,
  swingLookback: 10,
  minPullbackFraction: 0.02,
  profitTargetFraction: 0.0125,
};

const strategy = () => new TrendPullbackRecoveryStrategy(TF, PARAMS);

/** Exact `money * fraction` (fraction resolved to 1e9). */
function at(m: Money, fraction: number): Money {
  return m.mulFraction(BigInt(Math.round(fraction * Number(SCALE))), SCALE);
}

function cM(index: number, o: Money, h: Money, l: Money, cl: Money): Candle {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    timestampMs: BASE_TS + index * 300_000,
    open: o,
    high: h,
    low: l,
    close: cl,
    baseVolume: Money.fromNumber(1),
  };
}

function withBar(candles: Candle[], index: number, bar: Candle): Candle[] {
  const out = candles.slice();
  out[index] = bar;
  return out;
}

/** 19 rising closes 100 -> ~130.7 (bar 18 is the peak of the scanned window). */
function risingBase(): Candle[] {
  const out: Candle[] = [];
  let price = Money.fromNumber(100);
  for (let i = 0; i < 19; i++) {
    if (i > 0) price = at(price, 1.015);
    out.push(cM(i, price, at(price, 1.015), at(price, 0.985), price));
  }
  return out;
}

/**
 * A valid TPR setup at i = 20:
 *   - bar 18 is the swing high (prior window peak),
 *   - bar 19 is the pullback bar whose low is the structural pullback low P,
 *   - bar 20 is the recovery bar (close up, low above P).
 * The pullback low is the immediately preceding candle (fresh).
 */
function validSetup(): Candle[] {
  const out = risingBase();
  const peak = out[out.length - 1]!.close;
  out.push(cM(19, at(peak, 1.005), at(peak, 1.01), at(peak, 0.975), at(peak, 0.985)));
  out.push(cM(20, at(peak, 0.985), at(peak, 1.002), at(peak, 0.98), at(peak, 1.0)));
  return out;
}

/** Same as validSetup but the recovery is two bars after the pullback low (stale). */
function staleSetup(): Candle[] {
  const out = risingBase();
  const peak = out[out.length - 1]!.close;
  out.push(cM(19, at(peak, 1.005), at(peak, 1.01), at(peak, 0.975), at(peak, 0.985))); // low P at 19
  out.push(cM(20, at(peak, 0.99), at(peak, 1.0), at(peak, 0.978), at(peak, 0.995))); // up
  out.push(cM(21, at(peak, 0.995), at(peak, 1.005), at(peak, 0.985), at(peak, 1.003))); // recovery at 21
  return out;
}

/**
 * A setup whose pullback low P equals the SMA exactly (boundary "touch"), at
 * i = 20. SMA10 over closes[11..20] = (685 + 110 + 100 + 105) / 10 = 100 = P.
 */
function touchSmaSetup(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i <= 10; i++) {
    out.push(cM(i, Money.fromNumber(100), Money.fromNumber(100.5), Money.fromNumber(99.5), Money.fromNumber(100)));
  }
  const closes = [97, 98, 97, 98, 97, 98, 100];
  for (let j = 0; j < closes.length; j++) {
    const close = Money.fromNumber(closes[j]!);
    out.push(cM(11 + j, close, close.add(Money.fromNumber(1)), close.sub(Money.fromNumber(1)), close));
  }
  out.push(cM(18, Money.fromNumber(105), Money.fromNumber(120), Money.fromNumber(105), Money.fromNumber(110)));
  out.push(cM(19, Money.fromNumber(101), Money.fromNumber(102), Money.fromNumber(100), Money.fromNumber(100)));
  out.push(cM(20, Money.fromNumber(101), Money.fromNumber(106), Money.fromNumber(101), Money.fromNumber(105)));
  return out;
}

/**
 * A setup whose structural pullback low P sits `windowLow` below the prior swing
 * high H = 100, used to pin the documented minPullbackFraction boundary.
 *   - bars 10..18: close 97, low `windowLow`, high 99 except the swing-high bar 12
 *     (H = 100);
 *   - bar 19: the pullback bar, whose low is the window minimum (fresh: it is the
 *     immediately preceding candle at i = 20);
 *   - bar 20: the recovery bar (close 100 > previous close 98, low above P).
 * SMA10(current) = 97.4 and SMA10(i-3) = 96.6, so the trend/slope rules hold and
 * only the pullback-depth rule can gate the setup.
 */
function pullbackDepthSetup(windowLow: string): Candle[] {
  const out = Array.from({ length: 10 }, (_, i) =>
    cM(
      i,
      Money.fromString('95'),
      Money.fromString('95.5'),
      Money.fromString('94.5'),
      Money.fromString('95'),
    ),
  );
  for (let i = 10; i <= 18; i++) {
    out.push(
      cM(
        i,
        Money.fromString('97'),
        Money.fromString(i === 12 ? '100' : '99'),
        Money.fromString(windowLow),
        Money.fromString('97'),
      ),
    );
  }
  out.push(cM(19, Money.fromString('98'), Money.fromString('99'), Money.fromString(windowLow), Money.fromString('98')));
  out.push(cM(20, Money.fromString('100'), Money.fromString('100.5'), Money.fromString('98.5'), Money.fromString('100')));
  return out;
}

interface CtxOpts {
  quantity?: string;
  averageEntryPrice?: string;
  /** `undefined`/`null` => no anchor. A string => that exact anchor. */
  anchor?: string | null;
  insufficientData?: boolean;
}

function context(candles: Candle[], opts: CtxOpts = {}): StrategyContext {
  const quantity = opts.quantity ? Money.fromString(opts.quantity) : Money.zero();
  const anchor =
    opts.anchor === undefined || opts.anchor === null ? null : Money.fromString(opts.anchor);
  const position: PositionView = {
    symbol: SYMBOL,
    quantity,
    averageEntryPrice: opts.averageEntryPrice ? Money.fromString(opts.averageEntryPrice) : null,
    entryAnchorPrice: anchor,
    realizedPnl: Money.zero(),
  };
  return {
    nowMs: candles[candles.length - 1]!.timestampMs,
    symbol: SYMBOL,
    ticker: null,
    candles,
    timeframe: TF,
    position,
    insufficientData: opts.insufficientData ?? false,
  };
}

describe('TrendPullbackRecoveryStrategy — construction', () => {
  it('validates parameters and computes warmup', () => {
    expect(strategy().warmupCandles).toBe(13); // max(10+3, 10+1)
    expect(() => new TrendPullbackRecoveryStrategy(TF, { ...PARAMS, smaPeriod: 0 })).toThrow();
    expect(() => new TrendPullbackRecoveryStrategy(TF, { ...PARAMS, slopeLookback: -1 })).toThrow();
    expect(() => new TrendPullbackRecoveryStrategy(TF, { ...PARAMS, swingLookback: 2.5 })).toThrow();
    expect(() => new TrendPullbackRecoveryStrategy(TF, { ...PARAMS, minPullbackFraction: 0 })).toThrow();
    expect(() => new TrendPullbackRecoveryStrategy(TF, { ...PARAMS, profitTargetFraction: 1 })).toThrow();
  });

  it('describe() and registration use the pre-registered defaults', () => {
    expect(strategy().describe()).toBe(
      `trend-pullback-recovery(sma=10, slope=3, swing=10, pullback=0.02, target=0.0125)`,
    );
    const registered = createStrategy('trend-pullback-recovery', { timeframe: TF });
    expect(registered.id).toBe('trend-pullback-recovery');
    const tpr = registered as TrendPullbackRecoveryStrategy;
    expect(tpr.smaPeriod).toBe(DEFAULT_TPR_SMA_PERIOD);
    expect(tpr.slopeLookback).toBe(DEFAULT_TPR_SLOPE_LOOKBACK);
    expect(tpr.swingLookback).toBe(DEFAULT_TPR_SWING_LOOKBACK);
    expect(tpr.minPullbackFraction).toBe(DEFAULT_TPR_MIN_PULLBACK_FRACTION);
    expect(tpr.profitTargetFraction).toBe(DEFAULT_TPR_PROFIT_TARGET_FRACTION);
    expect(tpr.warmupCandles).toBe(DEFAULT_TPR_SMA_PERIOD + DEFAULT_TPR_SLOPE_LOOKBACK);
  });
});

describe('TrendPullbackRecoveryStrategy — warmup / invalid signal', () => {
  it('HOLD with fewer than warmup candles', () => {
    const candles = validSetup().slice(0, 12);
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('HOLD when insufficientData is flagged', () => {
    expect(strategy().evaluate(context(validSetup(), { insufficientData: true })).type).toBe('HOLD');
  });
});

describe('TrendPullbackRecoveryStrategy — entry (flat)', () => {
  it('1. BUY on a valid TPR setup', () => {
    const sig = strategy().evaluate(context(validSetup()));
    expect(sig.type).toBe('BUY');
  });

  it('2. BUY carries the exact structural pullback-low anchor', () => {
    const candles = validSetup();
    const expected = candles[19]!.low;
    const sig = strategy().evaluate(context(candles));
    expect(sig.type).toBe('BUY');
    expect(sig.entryAnchorPrice).not.toBeUndefined();
    expect(sig.entryAnchorPrice!.equals(expected)).toBe(true);
  });

  it('3. HOLD when close is not above the SMA', () => {
    let candles = validSetup();
    const peak = candles[18]!.close;
    candles = withBar(candles, 19, cM(19, at(peak, 0.89), at(peak, 0.9), at(peak, 0.87), at(peak, 0.88)));
    candles = withBar(candles, 20, cM(20, at(peak, 0.88), at(peak, 0.91), at(peak, 0.875), at(peak, 0.9)));
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('4. HOLD when the SMA slope is negative', () => {
    // Raise bars 8 and 9 (only in the SMA at i-3, not in the current SMA or the
    // swing window) so SMA(i) < SMA(i-3) while every other condition still holds.
    let candles = validSetup();
    candles = withBar(candles, 8, cM(8, Money.fromNumber(150), Money.fromNumber(151), Money.fromNumber(149), Money.fromNumber(150)));
    candles = withBar(candles, 9, cM(9, Money.fromNumber(150), Money.fromNumber(151), Money.fromNumber(149), Money.fromNumber(150)));
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('5. HOLD when the pullback is shallower than the required depth', () => {
    let candles = validSetup();
    const peak = candles[18]!.close;
    candles = withBar(candles, 18, cM(18, peak, at(peak, 1.015), at(peak, 0.999), peak));
    candles = withBar(candles, 19, cM(19, at(peak, 1.0), at(peak, 1.005), at(peak, 0.998), at(peak, 0.999)));
    candles = withBar(candles, 20, cM(20, at(peak, 0.999), at(peak, 1.002), at(peak, 0.9995), at(peak, 1.0)));
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('6. HOLD when the pullback low touches the SMA (P == SMA)', () => {
    expect(strategy().evaluate(context(touchSmaSetup())).type).toBe('HOLD');
  });

  it('7. HOLD when the pullback low crosses below the SMA', () => {
    let candles = validSetup();
    const peak = candles[18]!.close;
    candles = withBar(candles, 19, cM(19, at(peak, 0.915), at(peak, 0.92), at(peak, 0.9), at(peak, 0.91)));
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('8. HOLD without recovery (close <= previous close)', () => {
    let candles = validSetup();
    const peak = candles[18]!.close;
    candles = withBar(candles, 20, cM(20, at(peak, 0.985), at(peak, 0.99), at(peak, 0.976), at(peak, 0.98)));
    expect(strategy().evaluate(context(candles)).type).toBe('HOLD');
  });

  it('9. HOLD (no BUY) while already long — no pyramiding', () => {
    const sig = strategy().evaluate(
      context(validSetup(), { quantity: '1', averageEntryPrice: '300', anchor: '0.5' }),
    );
    expect(sig.type).toBe('HOLD');
    expect(sig.type).not.toBe('BUY');
  });

  it('18. a stale setup (pullback low not the prior candle) does not BUY; a fresh one does', () => {
    // The valid setup is consumed on bar 20; on bar 21 the same historical low is
    // two bars old, so a flat re-entry must NOT reuse it.
    expect(strategy().evaluate(context(validSetup())).type).toBe('BUY');
    expect(strategy().evaluate(context(staleSetup())).type).toBe('HOLD');
  });

  it('20. accepts a pullback EXACTLY at the 2% threshold (fixed-point boundary)', () => {
    // Swing high H = 100, pullback low P = 98: (100 - 98) / 100 = 0.02 exactly.
    // Money has scale 1e8 and Money.div truncates toward zero, but the pullback
    // depth is floor(D * 1e8) / 1e8, so `depth >= minPullback` iff D >= 0.02:
    // truncation can only make a depth smaller, never larger, and an exactly
    // representable D = 0.02 is computed exactly. The documented boundary is
    // therefore inclusive and requires no floating point.
    const sig = strategy().evaluate(context(pullbackDepthSetup('98')));
    expect(sig.type).toBe('BUY');
  });

  it('21. rejects a pullback just below the 2% threshold', () => {
    // Swing high H = 100, pullback low P = 98.01: depth = 0.0199 < 0.02.
    const sig = strategy().evaluate(context(pullbackDepthSetup('98.01')));
    expect(sig.type).toBe('HOLD');
    expect(sig.reason).toMatch(/below required/);
  });
});

describe('TrendPullbackRecoveryStrategy — exit (long)', () => {
  it('10. SELL on the profit target', () => {
    const sig = strategy().evaluate(
      context(validSetup(), { quantity: '1', averageEntryPrice: '125', anchor: '0.5' }),
    );
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/profit target/);
  });

  it('11. SELL on the frozen anchor (structural invalidation)', () => {
    const sig = strategy().evaluate(
      context(validSetup(), { quantity: '1', averageEntryPrice: '300', anchor: '131' }),
    );
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/entry anchor/);
  });

  it('12. SELL on SMA trend invalidation', () => {
    // Rising base then a decisive down bar below the SMA.
    const candles = risingBase();
    const peak = candles[candles.length - 1]!.close;
    candles.push(cM(19, at(peak, 0.91), at(peak, 0.92), at(peak, 0.89), at(peak, 0.9)));
    const sig = strategy().evaluate(
      context(candles, { quantity: '1', averageEntryPrice: '300', anchor: '0.5' }),
    );
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/SMA/);
  });

  it('13. HOLD when no exit condition is met', () => {
    const sig = strategy().evaluate(
      context(validSetup(), { quantity: '1', averageEntryPrice: '300', anchor: '0.5' }),
    );
    expect(sig.type).toBe('HOLD');
    expect(sig.reason).toMatch(/holding long/);
  });

  it('14. a null anchor never triggers an anchor-based SELL', () => {
    const sig = strategy().evaluate(
      context(validSetup(), { quantity: '1', averageEntryPrice: '300', anchor: null }),
    );
    expect(sig.type).toBe('HOLD');
    expect(sig.entryAnchorPrice).toBeUndefined();
  });

  it('15. the SELL uses the FROZEN anchor, never a deeper low recomputed from candles', () => {
    // A deeper low Q (100) appears in the recent candles. The position's frozen
    // anchor is P = 131. close = ~130.7 is between Q and P, so ONLY the frozen P
    // can trigger the structural exit.
    let candles = validSetup();
    candles = withBar(candles, 19, cM(19, Money.fromString('110'), Money.fromString('120'), Money.fromString('100'), Money.fromString('115')));
    const sig = strategy().evaluate(
      context(candles, { quantity: '1', averageEntryPrice: '300', anchor: '131' }),
    );
    expect(sig.type).toBe('SELL');
    expect(sig.reason).toMatch(/entry anchor/);
    // Sanity: the deeper low Q is indeed below the frozen anchor and close is above Q.
    expect(Money.fromString('100').compareTo(Money.fromString('131'))).toBeLessThan(0);
    expect(candles[candles.length - 1]!.close.compareTo(Money.fromString('100'))).toBeGreaterThan(0);
  });

  it('19. a LATER deeper low Q never replaces the frozen entry anchor P (SELL on P, HOLD on Q)', () => {
    // Establish the entry setup, whose structural pullback low P is frozen at a
    // TPR BUY decision. Then append a LATER candle carrying a substantially
    // deeper low Q < P. A strategy that reconstructed the pullback low from
    // rolling candles would pick Q and hold; the frozen-anchor behaviour must
    // still sell against P.
    const candles = validSetup();
    const P = candles[19]!.low; // the anchor the BUY decision would freeze
    const peak = candles[18]!.close;
    const Q = at(peak, 0.5); // later, substantially deeper low
    const close = at(peak, 0.97); // strictly between Q and P
    candles.push(cM(21, at(peak, 0.99), at(peak, 0.995), Q, close));

    // Sanity: Q < close < P, and Q is on the LATER candle, not the decision bar.
    expect(Q.compareTo(P)).toBeLessThan(0);
    expect(close.compareTo(Q)).toBeGreaterThan(0);
    expect(close.compareTo(P)).toBeLessThan(0);

    // With the FROZEN anchor P the structural exit fires...
    const frozen = strategy().evaluate(
      context(candles, { quantity: '1', averageEntryPrice: '300', anchor: P.toString() }),
    );
    expect(frozen.type).toBe('SELL');
    expect(frozen.reason).toMatch(/entry anchor/);

    // ...and if the anchor were (wrongly) the later low Q, the exact same candles
    // would HOLD. This proves the SELL above is attributable to P and that the
    // strategy does not substitute the later low Q for the frozen anchor.
    const recomputed = strategy().evaluate(
      context(candles, { quantity: '1', averageEntryPrice: '300', anchor: Q.toString() }),
    );
    expect(recomputed.type).toBe('HOLD');
    expect(recomputed.reason).toMatch(/holding long/);
  });
});
