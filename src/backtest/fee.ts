/**
 * Backtest fee model (Backtesting V1).
 *
 * V1 models a QUOTE-denominated percentage fee. The rate is declared on the
 * config (`BacktestFeeModel`). A base-denominated fee is rejected upstream
 * (`validateConfig`) rather than converted — simulated fees are a MODEL, never
 * exchange evidence.
 */

import { Money } from '../money/Money.js';
import type { BacktestFeeModel } from './types.js';

/** Scales the rate to an exact fraction numerator (rate resolved to 9 decimals). */
const FEE_SCALE: bigint = 1_000_000_000n;

/**
 * Compute the quote-denominated fee on a notional, exact fixed-point.
 * `fee = notional.mulFraction(round(rate*1e9), 1e9)`, deterministic.
 */
export function computeQuoteFee(notional: Money, feeModel: BacktestFeeModel): Money {
  const rateScaled = BigInt(Math.round(feeModel.rate * Number(FEE_SCALE)));
  return notional.mulFraction(rateScaled, FEE_SCALE);
}
