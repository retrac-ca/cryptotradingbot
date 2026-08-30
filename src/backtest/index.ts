/**
 * Backtest module.
 *
 * Replays historical candles through the strategy -> risk -> execution pipeline
 * with simulated execution and produces a performance report. Results are a
 * HISTORICAL SIMULATION, not a prediction of future performance.
 *
 * Also provides a small loader for reading candle history from a JSON file
 * (the format written by e.g. `scripts/` or a prior candle fetch) for use by
 * the `backtest` CLI command.
 */

export { BacktestRunner } from './BacktestRunner.js';
export { computeMetrics } from './report.js';
export type { MetricsInput } from './report.js';
export type {
  BacktestConfig,
  BacktestMetrics,
  BacktestRejection,
  BacktestResult,
  BacktestTrade,
} from './types.js';

import { readFileSync } from 'node:fs';
import { Money } from '../money/Money.js';
import type { Candle, Timeframe } from '../types.js';

/**
 * Load candles from a JSON file. Expected shape: an array of
 * `{ symbol, timeframe, timestampMs, open, high, low, close, baseVolume }`
 * where prices are numeric strings (decimal). Returns canonical Candle objects.
 */
export function loadCandlesFromFile(path: string): Candle[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
  const candles: Candle[] = [];
  for (const row of raw) {
    const symbol = (row as { symbol?: string }).symbol ?? '';
    const timeframe = (row as { timeframe?: string }).timeframe ?? '1d';
    candles.push({
      symbol,
      timeframe: timeframe as Timeframe,
      timestampMs: row.timestampMs as number,
      open: Money.fromString((row.open as { toString(): string }).toString()),
      high: Money.fromString((row.high as { toString(): string }).toString()),
      low: Money.fromString((row.low as { toString(): string }).toString()),
      close: Money.fromString((row.close as { toString(): string }).toString()),
      baseVolume: Money.fromString((row.baseVolume as { toString(): string }).toString()),
    });
  }
  return candles;
}
