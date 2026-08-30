/**
 * `bot backtest` — run a historical backtest of the configured strategy.
 *
 * Replays historical candles from a JSON file through the strategy -> risk ->
 * execution pipeline with simulated execution and reports performance.
 *
 * Usage:
 *   bot backtest <candles.json> [--initial-capital N] [--fee F] [--slippage S]
 *
 * The candles file must be a JSON array with objects of the canonical candle
 * shape (see src/backtest#loadCandlesFromFile).
 *
 * NOTE: results are a HISTORICAL SIMULATION, not a prediction of future
 * performance.
 */

import { writeFileSync } from 'node:fs';
import { Money } from '../money/Money.js';
import { loadConfig } from '../config/load.js';
import { loadCandlesFromFile, BacktestRunner } from '../backtest/index.js';
import { buildStrategy } from '../strategy/index.js';
import { buildRiskManager } from '../risk/index.js';
import type { CommandHandler } from './context.js';

function parseArgs(args: string[]): {
  file: string;
  initialCapital: number;
  feeFraction: number;
  slippageFraction: number;
  outFile: string | null;
} {
  let file = '';
  let initialCapital = 10000;
  let feeFraction = 0.002;
  let slippageFraction = 0;
  let outFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--initial-capital') initialCapital = Number(args[++i]);
    else if (a === '--fee') feeFraction = Number(args[++i]);
    else if (a === '--slippage') slippageFraction = Number(args[++i]);
    else if (a === '--out') outFile = args[++i] ?? null;
    else if (!a.startsWith('--')) file = a;
  }
  if (!file) throw new Error('usage: bot backtest <candles.json> [--initial-capital N] [--fee F] [--slippage S] [--out FILE]');
  return { file, initialCapital, feeFraction, slippageFraction, outFile };
}

export const backtestCommand: CommandHandler = async (args): Promise<number> => {
  const opts = parseArgs(args);

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + message);
    return 1;
  }

  let candles;
  try {
    candles = loadCandlesFromFile(opts.file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Failed to load candles: ' + message);
    return 1;
  }
  if (candles.length === 0) {
    // eslint-disable-next-line no-console
    console.error('No candles found in file.');
    return 1;
  }

  const symbol = candles[0]!.symbol || cfg.tradingPairs[0]!;
  const quote = symbol.split('/')[1]!;
  const strategy = buildStrategy(cfg);
  const riskManager = buildRiskManager(cfg);
  const runner = new BacktestRunner(strategy, riskManager);

  const result = runner.run(candles, {
    symbol,
    timeframe: cfg.timeframe,
    initialCash: Money.fromNumber(opts.initialCapital),
    quoteCurrency: quote,
    feeFraction: opts.feeFraction,
    slippageFraction: opts.slippageFraction,
  });

  const m = result.metrics;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  // eslint-disable-next-line no-console
  console.log('\nBacktest result (' + symbol + ', ' + cfg.timeframe + ')');
  // eslint-disable-next-line no-console
  console.log('  Candles:          ' + m.candles);
  // eslint-disable-next-line no-console
  console.log('  Starting capital: ' + m.startingCapital.toString());
  // eslint-disable-next-line no-console
  console.log('  Ending capital:   ' + m.endingCapital.toString());
  // eslint-disable-next-line no-console
  console.log('  Total return:     ' + pct(m.totalReturnFraction));
  // eslint-disable-next-line no-console
  console.log('  Trade count:      ' + m.tradeCount);
  // eslint-disable-next-line no-console
  console.log('  Winning trades:   ' + m.winningTrades);
  // eslint-disable-next-line no-console
  console.log('  Losing trades:    ' + m.losingTrades);
  // eslint-disable-next-line no-console
  console.log('  Win rate:         ' + pct(m.winRate));
  // eslint-disable-next-line no-console
  console.log('  Realized P&L:     ' + m.realizedPnl.toString());
  // eslint-disable-next-line no-console
  console.log('  Fees paid:        ' + m.feesPaid.toString());
  // eslint-disable-next-line no-console
  console.log('  Max drawdown:     ' + pct(m.maxDrawdownFraction));
  // eslint-disable-next-line no-console
  console.log('  Largest win:      ' + m.largestWin.toString());
  // eslint-disable-next-line no-console
  console.log('  Largest loss:     ' + m.largestLoss.toString());
  // eslint-disable-next-line no-console
  console.log('\n  NOTE: Historical simulation only; not a prediction of future performance.');

  if (opts.outFile) {
    writeFileSync(opts.outFile, JSON.stringify({ config: result.config, metrics: m }, null, 2));
    // eslint-disable-next-line no-console
    console.log('  Wrote JSON report to ' + opts.outFile);
  }

  return 0;
};
