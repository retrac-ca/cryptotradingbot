/**
 * Backtest module (Backtesting V1).
 *
 * Replays historical candles through the existing `Strategy` -> `RiskManager`
 * -> `Portfolio` pipeline with a deterministic, conservative, next-open simulated
 * execution, and produces an auditable performance result. Results are a
 * HISTORICAL SIMULATION, not a prediction of future performance.
 *
 * The public boundary is `runBacktest(input)`, which takes FACTORIES for the
 * strategy and risk manager so the two can never leak mutable state between
 * runs.
 */

export { runBacktest, buildMarketInfo } from './engine.js';
export { computeMetrics } from './report.js';
export {
  validateCandles,
  validateConfig,
  BacktestValidationError,
} from './validation.js';
export { computeQuoteFee } from './fee.js';
export { computeFillPrice } from './fill.js';
export type {
  BacktestConfig,
  BacktestRunInput,
  BacktestResult,
  BacktestTrade,
  BacktestRejection,
  BacktestMetrics,
  BacktestMarketConstraints,
  BacktestFeeModel,
  BacktestFeeModelRate,
} from './types.js';
export type { MetricsInput } from './report.js';

import { readFileSync } from 'node:fs';
import { Money } from '../money/Money.js';
import type { Candle, Timeframe } from '../types.js';

/**
 * Load candles from a JSON file. Expected shape: an array of
 * `{ symbol, timeframe, timestampMs, open, high, low, close, baseVolume }`
 * where prices are numeric strings (decimal). Returns canonical Candle objects.
 *
 * This only parses; semantic validation (ordering, duplicates, OHLC, warmup) is
 * performed fail-closed by `runBacktest` via `validateCandles`.
 */
export function loadCandlesFromFile(path: string): Candle[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  if (!Array.isArray(raw)) {
    throw new Error(`candle file ${path} must contain a JSON array`);
  }
  const candles: Candle[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const row = raw[idx];
    if (!row || typeof row !== 'object') {
      throw new Error(`candle row ${idx} is not an object`);
    }
    const asMoney = (field: string): Money => {
      const v = (row as Record<string, unknown>)[field];
      if (v === undefined || v === null) {
        throw new Error(`candle row ${idx} is missing "${field}"`);
      }
      return Money.fromString(String(v));
    };
    const symbol = (row as { symbol?: unknown }).symbol ?? '';
    const timeframe = (row as { timeframe?: unknown }).timeframe ?? '1d';
    candles.push({
      symbol: String(symbol),
      timeframe: timeframe as Timeframe,
      timestampMs: Number((row as { timestampMs?: unknown }).timestampMs),
      open: asMoney('open'),
      high: asMoney('high'),
      low: asMoney('low'),
      close: asMoney('close'),
      baseVolume: asMoney('baseVolume'),
    });
  }
  return candles;
}
