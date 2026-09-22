/**
 * Trend–Pullback–Recovery (TPR) strategy.
 *
 * A long-only, fully STATELESS rule on completed candles (pre-registered on the
 * 5-minute timeframe). It encodes a trend-following "buy the pullback" setup:
 *
 *   Trend          : close is above the SMA and the SMA is non-decreasing
 *                    versus `slopeLookback` bars earlier.
 *   Pullback       : price has retraced at least `minPullbackFraction` from a
 *                    prior swing high within the `swingLookback` window, while
 *                    the pullback low held strictly above the SMA.
 *   Recovery       : the current close is above the previous close, on the bar
 *                    immediately following the pullback low.
 *
 * BUY (flat only, all true on the current completed candle):
 *   1. close > SMA
 *   2. SMA(current) >= SMA(current - slopeLookback)  (non-decreasing)
 *   3. a prior swing high exists in [i - swingLookback, i - 1]
 *   4. (swingHigh - P) / swingHigh >= minPullbackFraction, where the swing high
 *      strictly PRECEDES the pullback low (a genuine pullback leg, never the
 *      prior candle's own range)
 *   5. P > SMA
 *   6. close > previous close
 *   7. the setup is FRESH: the pullback low P was made on the immediately
 *      preceding candle, so the setup can only be consumed on the recovery bar
 *      and cannot be repeatedly harvested from the same historical pullback.
 *
 *   where the entry anchor is P = minimum(low[h..i]) and h is the index of the
 *   highest high in the prior `swingLookback` candles (strictly before i). The
 *   anchor is attached to the BUY signal via `Signal.entryAnchorPrice` at
 *   DECISION time and is never recomputed later.
 *
 * SELL (long only, ANY true):
 *   1. close >= averageEntryPrice * (1 + profitTargetFraction)
 *   2. close < position.entryAnchorPrice (only when the anchor is non-null)
 *   3. close < SMA
 *
 * Otherwise HOLD.
 *
 * Properties (deliberate):
 *   - Stateless: no cross-state, no setup state machine, no entry tracking. The
 *     signal is a pure function of the frozen `StrategyContext`, so restart and
 *     replay are safe. After entry, the frozen `PositionView.entryAnchorPrice`
 *     is the state the exits need.
 *   - No averaging down, no pyramiding, no max holding time, no separate
 *     percentage stop. The existing RiskManager remains the only risk control.
 *   - No lookahead: the swing high and the SMA comparison use only candles at or
 *     before the current completed decision candle.
 *   - All price arithmetic uses the exact fixed-point `Money` type — no floating
 *     point is used for prices.
 *
 * FRESHNESS (condition 7) is implemented statelessly as "the last occurrence of
 * the pullback-window minimum low is the immediately preceding candle". This is
 * the only stateless, no-lookahead way to guarantee the same historical pullback
 * cannot be re-consumed after the position is closed, without strategy memory.
 *
 * This strategy is an EXPERIMENT. It is NOT a claim of profitability and its
 * parameters are pre-registered, not tuned.
 */

import { Money } from '../money/Money.js';
import { sma } from './indicators.js';
import type { StrategyContext } from './StrategyContext.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './Signal.js';
import { signal } from './Signal.js';
import { registerStrategy, type StrategyRegistryParams } from './registry.js';

/** Pre-registered SMA period (48 completed 5m candles = 4h). */
export const DEFAULT_TPR_SMA_PERIOD = 48;
/** Pre-registered SMA slope lookback (bars). */
export const DEFAULT_TPR_SLOPE_LOOKBACK = 12;
/** Pre-registered swing-high lookback window (bars). */
export const DEFAULT_TPR_SWING_LOOKBACK = 48;
/** Pre-registered minimum pullback depth from the swing high (0.02 = 2%). */
export const DEFAULT_TPR_MIN_PULLBACK_FRACTION = 0.02;
/** Pre-registered profit target above the average entry price (0.0125 = 1.25%). */
export const DEFAULT_TPR_PROFIT_TARGET_FRACTION = 0.0125;

/** Resolve a fraction to an exact fixed-point `Money` value (scale 1e8). */
function fractionToMoney(fraction: number): Money {
  const scale = 1_000_000_000n;
  const numerator = BigInt(Math.round(fraction * Number(scale)));
  if (numerator === 0n) return Money.zero();
  return Money.fromScaled((numerator * 100_000_000n) / scale);
}

export interface TrendPullbackRecoveryParams {
  /** SMA period over closes (>= 1). */
  smaPeriod: number;
  /** Bars back for the SMA slope comparison (>= 1). */
  slopeLookback: number;
  /** Number of PRIOR completed candles scanned for the swing high (>= 1). */
  swingLookback: number;
  /** Minimum pullback depth from the swing high, in (0, 1). */
  minPullbackFraction: number;
  /** Profit target above average entry, in (0, 1). */
  profitTargetFraction: number;
}

export class TrendPullbackRecoveryStrategy implements Strategy {
  readonly id = 'trend-pullback-recovery';
  readonly name = 'Trend Pullback Recovery';
  readonly timeframe;
  readonly warmupCandles;
  readonly smaPeriod;
  readonly slopeLookback;
  readonly swingLookback;
  readonly minPullbackFraction;
  readonly profitTargetFraction;

  /** Exact fixed-point minimum pullback threshold. */
  private readonly minPullback: Money;
  /** Exact rational profit-target multiplier: 1 + profitTargetFraction. */
  private readonly profitNumerator: bigint;
  private readonly profitDenominator: bigint;

  constructor(timeframe: Strategy['timeframe'], params: TrendPullbackRecoveryParams) {
    const { smaPeriod, slopeLookback, swingLookback, minPullbackFraction, profitTargetFraction } = params;
    if (!Number.isInteger(smaPeriod) || smaPeriod <= 0) {
      throw new Error('TrendPullbackRecovery: smaPeriod must be a positive integer.');
    }
    if (!Number.isInteger(slopeLookback) || slopeLookback <= 0) {
      throw new Error('TrendPullbackRecovery: slopeLookback must be a positive integer.');
    }
    if (!Number.isInteger(swingLookback) || swingLookback <= 0) {
      throw new Error('TrendPullbackRecovery: swingLookback must be a positive integer.');
    }
    if (!Number.isFinite(minPullbackFraction) || minPullbackFraction <= 0 || minPullbackFraction >= 1) {
      throw new Error('TrendPullbackRecovery: minPullbackFraction must be a finite fraction in (0, 1).');
    }
    if (!Number.isFinite(profitTargetFraction) || profitTargetFraction <= 0 || profitTargetFraction >= 1) {
      throw new Error('TrendPullbackRecovery: profitTargetFraction must be a finite fraction in (0, 1).');
    }

    this.timeframe = timeframe;
    this.smaPeriod = smaPeriod;
    this.slopeLookback = slopeLookback;
    this.swingLookback = swingLookback;
    this.minPullbackFraction = minPullbackFraction;
    this.profitTargetFraction = profitTargetFraction;

    // Enough candles for the current SMA, the SMA `slopeLookback` bars earlier,
    // and a swing window of `swingLookback` prior candles.
    this.warmupCandles = Math.max(smaPeriod + slopeLookback, swingLookback + 1);

    this.minPullback = fractionToMoney(minPullbackFraction);
    // 1 + profitTargetFraction as an exact rational (resolved to 1e9 then scaled).
    const scale = 1_000_000_000n;
    this.profitNumerator = scale + BigInt(Math.round(profitTargetFraction * Number(scale)));
    this.profitDenominator = scale;
  }

  evaluate(context: StrategyContext): Signal {
    const { symbol, candles, position, nowMs, insufficientData } = context;

    if (insufficientData || candles.length < this.warmupCandles) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    const currentClose = candles[candles.length - 1]!.close;
    const ma = sma(candles, this.smaPeriod);
    if (ma === null || !ma.isPositive()) {
      return signal(symbol, 'HOLD', { reason: 'insufficient data' }, nowMs);
    }

    // --- Existing long: evaluate the exits. ---
    if (position.quantity.isPositive()) {
      return this.exitSignal(context, ma, currentClose);
    }

    // A negative/non-zero non-long quantity is never traded (V1 is long-only).
    if (!position.quantity.isZero()) {
      return signal(symbol, 'HOLD', { reason: 'non-flat position' }, nowMs);
    }

    // --- Flat: evaluate the entry. ---
    return this.entrySignal(context, ma, currentClose);
  }

  /** SELL when any exit condition holds; otherwise HOLD the long. */
  private exitSignal(context: StrategyContext, ma: Money, currentClose: Money): Signal {
    const { symbol, position, nowMs } = context;

    // 1. Profit target from the durable average entry price (includes entry fees).
    const entry = position.averageEntryPrice;
    if (entry !== null && entry.isPositive()) {
      const target = entry.mulFraction(this.profitNumerator, this.profitDenominator);
      if (currentClose.compareTo(target) >= 0) {
        return signal(
          symbol,
          'SELL',
          {
            confidence: 0.6,
            reason: `profit target: close ${currentClose} >= entry*${1 + this.profitTargetFraction} ${target}`,
          },
          nowMs,
        );
      }
    }

    // 2. Structural invalidation at the FROZEN entry anchor (never recomputed).
    const anchor = position.entryAnchorPrice;
    if (anchor !== null && currentClose.compareTo(anchor) < 0) {
      return signal(
        symbol,
        'SELL',
        { confidence: 0.6, reason: `close ${currentClose} below entry anchor ${anchor}` },
        nowMs,
      );
    }

    // 3. Trend invalidation.
    if (currentClose.compareTo(ma) < 0) {
      return signal(
        symbol,
        'SELL',
        { confidence: 0.6, reason: `close ${currentClose} below SMA${this.smaPeriod} ${ma}` },
        nowMs,
      );
    }

    return signal(symbol, 'HOLD', { reason: 'holding long' }, nowMs);
  }

  /** BUY on a fresh valid TPR setup; otherwise HOLD. */
  private entrySignal(context: StrategyContext, ma: Money, currentClose: Money): Signal {
    const { symbol, candles, nowMs } = context;
    const i = candles.length - 1;
    const prevClose = candles[i - 1]!.close;

    // 2. SMA non-decreasing versus `slopeLookback` bars earlier.
    const priorMa = sma(candles.slice(0, i - this.slopeLookback + 1), this.smaPeriod);
    if (priorMa === null || ma.compareTo(priorMa) < 0) {
      return signal(symbol, 'HOLD', { reason: `SMA${this.smaPeriod} not rising` }, nowMs);
    }

    // 1. Close above the SMA.
    if (currentClose.compareTo(ma) <= 0) {
      return signal(
        symbol,
        'HOLD',
        { reason: `close ${currentClose} not above SMA${this.smaPeriod} ${ma}` },
        nowMs,
      );
    }

    // 3. Prior swing high within the prior `swingLookback` candles.
    const windowStart = i - this.swingLookback;
    let swingHigh: Money | null = null;
    let swingHighIndex = -1;
    for (let k = windowStart; k <= i - 1; k++) {
      const high = candles[k]!.high;
      if (swingHigh === null || high.compareTo(swingHigh) > 0) {
        swingHigh = high;
        swingHighIndex = k;
      }
    }
    if (swingHigh === null || swingHighIndex < 0 || !swingHigh.isPositive()) {
      return signal(symbol, 'HOLD', { reason: 'no prior swing high' }, nowMs);
    }

    // Pullback low P = minimum(low[h..i]); track the LAST index achieving it so
    // the freshness check below is deterministic on ties.
    let pullbackLow: Money | null = null;
    let pullbackLowIndex = -1;
    for (let k = swingHighIndex; k <= i; k++) {
      const low = candles[k]!.low;
      if (pullbackLow === null || low.compareTo(pullbackLow) <= 0) {
        pullbackLow = low;
        pullbackLowIndex = k;
      }
    }
    if (pullbackLow === null) {
      return signal(symbol, 'HOLD', { reason: 'no pullback low' }, nowMs);
    }

    // The swing high must PRECEDE the pullback low: a genuine pullback leg descends
    // from the high to the low. This rejects the degenerate "the prior candle's own
    // range" case (high and low on the same bar), which is not a pullback.
    if (swingHighIndex >= pullbackLowIndex) {
      return signal(symbol, 'HOLD', { reason: 'no pullback leg from the swing high' }, nowMs);
    }

    // 4. Pullback depth from the swing high.
    const depth = swingHigh.sub(pullbackLow).div(swingHigh);
    if (depth.compareTo(this.minPullback) < 0) {
      return signal(
        symbol,
        'HOLD',
        { reason: `pullback ${depth} below required ${this.minPullback}` },
        nowMs,
      );
    }

    // 5. The pullback low held strictly above the SMA.
    if (pullbackLow.compareTo(ma) <= 0) {
      return signal(
        symbol,
        'HOLD',
        { reason: `pullback low ${pullbackLow} not above SMA${this.smaPeriod} ${ma}` },
        nowMs,
      );
    }

    // 6. Recovery: current close above the previous close.
    if (currentClose.compareTo(prevClose) <= 0) {
      return signal(symbol, 'HOLD', { reason: 'no recovery (close not above previous close)' }, nowMs);
    }

    // 7. Fresh setup: the pullback low must be the immediately preceding candle.
    // This makes the entry transient (consumed on this recovery bar) and
    // guarantees the same historical pullback can never be re-consumed.
    if (pullbackLowIndex !== i - 1) {
      return signal(symbol, 'HOLD', { reason: 'stale setup (pullback low is not the prior candle)' }, nowMs);
    }

    return signal(
      symbol,
      'BUY',
      {
        confidence: 0.6,
        reason:
          `TPR: uptrend, ${depth} pullback from swing high ${swingHigh} ` +
          `to ${pullbackLow}, recovery close ${currentClose}`,
        // The anchor is the structural pullback low, frozen at decision time.
        entryAnchorPrice: pullbackLow,
      },
      nowMs,
    );
  }

  describe(): string {
    return (
      `trend-pullback-recovery(sma=${this.smaPeriod}, slope=${this.slopeLookback}, ` +
      `swing=${this.swingLookback}, pullback=${this.minPullbackFraction}, ` +
      `target=${this.profitTargetFraction})`
    );
  }
}

// Self-registration mirrors the other built-ins: importing this module makes the
// strategy available to createStrategy(). The pre-registered TPR values are the
// defaults; they are not exposed through the normal `.env` configuration.
registerStrategy('trend-pullback-recovery', (params: StrategyRegistryParams) => {
  return new TrendPullbackRecoveryStrategy(params.timeframe, {
    smaPeriod: DEFAULT_TPR_SMA_PERIOD,
    slopeLookback: DEFAULT_TPR_SLOPE_LOOKBACK,
    swingLookback: DEFAULT_TPR_SWING_LOOKBACK,
    minPullbackFraction: DEFAULT_TPR_MIN_PULLBACK_FRACTION,
    profitTargetFraction: DEFAULT_TPR_PROFIT_TARGET_FRACTION,
  });
});
