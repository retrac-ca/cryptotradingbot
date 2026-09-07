/**
 * Fail-closed validation for the backtest (Backtesting V1).
 *
 * Historical input is validated BEFORE the deterministic simulation. The
 * philosophy: reject ambiguous/malformed data deterministically rather than
 * silently "repairing" it into a plausible backtest (no re-sorting, no
 * synthesizing missing candles, no inventing timestamps).
 */

import { Money } from '../money/Money.js';
import type { Candle } from '../types.js';
import type { BacktestConfig } from './types.js';

/**
 * Raised when the backtest input (candles or config/constraints) is invalid.
 * This is a deliberate, deterministic rejection — the caller must not proceed
 * with an ambiguous dataset.
 */
export class BacktestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestValidationError';
  }
}

export interface CandleValidation {
  ok: boolean;
  reason?: string;
  warnings: string[];
}

/**
 * Validate the candle series structurally, fail closed.
 *
 * Rejects the whole dataset when:
 *  - it is empty/not an array;
 *  - a candle is not an object or lacks a finite, positive timestamp;
 *  - timestamps are not strictly ascending (duplicates or out-of-order);
 *  - open/high/low/close is not strictly positive;
 *  - OHLC relationships are impossible (high < low, or high/low outside open/close);
 *  - baseVolume is negative.
 *
 * Warnings (never fatal, recorded) for truly non-fatal irregularities that the
 * deterministic loop handles without inventing data (e.g. a missing bar / gap).
 */
export function validateCandles(candles: Candle[]): CandleValidation {
  const warnings: string[] = [];
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, reason: 'empty candle dataset', warnings };
  }

  let prevTs: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || typeof c !== 'object') {
      return { ok: false, reason: `candle[${i}] is not an object`, warnings };
    }
    if (typeof c.timestampMs !== 'number' || !Number.isFinite(c.timestampMs) || c.timestampMs <= 0) {
      return { ok: false, reason: `candle[${i}] has an invalid timestamp`, warnings };
    }
    if (prevTs !== null && c.timestampMs <= prevTs) {
      return {
        ok: false,
        reason: `candle[${i}] timestamp ${c.timestampMs} is not strictly ascending (previous ${prevTs})`,
        warnings,
      };
    }
    prevTs = c.timestampMs;

    if (c.open === undefined || c.open === null) {
      return { ok: false, reason: `candle[${i}] is missing an open price`, warnings };
    }
    for (const [field, value] of [
      ['open', c.open],
      ['high', c.high],
      ['low', c.low],
      ['close', c.close],
    ] as const) {
      if (!value || value.isNegativeOrZero()) {
        return { ok: false, reason: `candle[${i}] ${field} is not strictly positive`, warnings };
      }
    }

    if (c.high.compareTo(c.low) < 0) {
      return { ok: false, reason: `candle[${i}] high (${c.high}) is below low (${c.low})`, warnings };
    }
    if (c.low.compareTo(c.open) > 0 || c.low.compareTo(c.close) > 0) {
      return { ok: false, reason: `candle[${i}] low exceeds open/close`, warnings };
    }
    if (c.high.compareTo(c.open) < 0 || c.high.compareTo(c.close) < 0) {
      return { ok: false, reason: `candle[${i}] high is below open/close`, warnings };
    }

    if (c.baseVolume && c.baseVolume.isNegative()) {
      return { ok: false, reason: `candle[${i}] has negative baseVolume`, warnings };
    }
  }

  return { ok: true, warnings };
}

/**
 * Validate the backtest configuration and market constraints, fail closed.
 *
 * Rejects:
 *  - missing/non-string symbol, or a non-BASE/QUOTE symbol;
 *  - a quoteCurrency that does not match the symbol's quote part;
 *  - an initialCash that is negative;
 *  - missing market constraints, or non-positive priceTick/quantityTick;
 *  - a negative minOrderBase (null is allowed = "not enforced");
 *  - a missing/unsupported fee model (V1: quote-denominated rate only);
 *  - a negative/non-finite fee rate;
 *  - a negative/non-finite slippage fraction.
 */
export function validateConfig(config: BacktestConfig): void {
  if (!config || typeof config !== 'object') {
    throw new BacktestValidationError('backtest config is required');
  }
  if (typeof config.symbol !== 'string' || !config.symbol.includes('/')) {
    throw new BacktestValidationError('backtest symbol must be a BASE/QUOTE string, e.g. "BTC/CAD"');
  }
  if (typeof config.quoteCurrency !== 'string' || config.quoteCurrency === '') {
    throw new BacktestValidationError('backtest quoteCurrency is required');
  }
  const symbolQuote = config.symbol.split('/')[1] ?? '';
  if (config.quoteCurrency !== symbolQuote) {
    throw new BacktestValidationError(
      `backtest quoteCurrency "${config.quoteCurrency}" must equal the symbol quote part "${symbolQuote}"`,
    );
  }
  if (!config.initialCash || config.initialCash.isNegative()) {
    throw new BacktestValidationError('backtest initialCash must be present and non-negative');
  }

  const mc = config.marketConstraints;
  if (!mc || typeof mc !== 'object') {
    throw new BacktestValidationError('backtest requires explicit market constraints (priceTick, quantityTick, minOrderBase)');
  }
  if (!mc.priceTick || !mc.priceTick.isPositive()) {
    throw new BacktestValidationError('backtest priceTick must be present and strictly positive');
  }
  if (!mc.quantityTick || !mc.quantityTick.isPositive()) {
    throw new BacktestValidationError('backtest quantityTick must be present and strictly positive');
  }
  if (mc.minOrderBase !== null && mc.minOrderBase.isNegative()) {
    throw new BacktestValidationError('backtest minOrderBase must be null (no minimum) or non-negative');
  }

  const fee = config.feeModel;
  if (!fee) {
    throw new BacktestValidationError('backtest requires a fee model');
  }
  if (fee.kind !== 'rate') {
    throw new BacktestValidationError(`unsupported backtest fee model kind "${fee.kind}" (only "rate")`);
  }
  if (fee.currency !== 'quote') {
    throw new BacktestValidationError(
      `backtest fee currency "${fee.currency}" is not supported in V1 (quote-denominated fees only)` +
        '; base-denominated fees are rejected, never silently converted',
    );
  }
  if (typeof fee.rate !== 'number' || !Number.isFinite(fee.rate) || fee.rate < 0) {
    throw new BacktestValidationError('backtest fee rate must be a finite, non-negative number');
  }

  if (typeof config.slippageFraction !== 'number' || !Number.isFinite(config.slippageFraction) || config.slippageFraction < 0) {
    throw new BacktestValidationError('backtest slippageFraction must be a finite, non-negative number');
  }
}

/** Reusable sanity assert for `Money`-typed fields used across the backtest. */
export function assertMoneyFinite(label: string, value: Money): void {
  if (!value || !Number.isFinite(Number(value.scaled))) {
    throw new BacktestValidationError(`${label} must be a valid finite money amount`);
  }
}
