/**
 * `bot backtest` — run a deterministic historical backtest of the configured
 * strategy.
 *
 * Replays historical candles from a JSON file through the existing strategy ->
 * risk -> Portfolio pipeline with a conservative next-open simulated execution
 * and reports performance.
 *
 * Usage:
 *   bot backtest <candles.json> [--initial-capital N] [--fee F] [--slippage S]
 *                 [--price-tick P] [--quantity-tick Q] [--min-order-base B]
 *                 [--out FILE]
 *
 * Explicit market constraints (`--price-tick`, `--quantity-tick`,
 * `--min-order-base`) are REQUIRED; the simulator never invents tick/minimum
 * defaults. Fee and slippage must be non-negative. Results are a HISTORICAL
 * SIMULATION, not a prediction of future performance.
 */

import { writeFileSync } from 'node:fs';
import { Money } from '../money/Money.js';
import { loadConfig } from '../config/load.js';
import { runBacktest, loadCandlesFromFile } from '../backtest/index.js';
import { buildStrategy } from '../strategy/index.js';
import { buildRiskManager } from '../risk/index.js';
import type { BacktestConfig, BacktestMarketConstraints } from '../backtest/types.js';
import type { CommandHandler } from './context.js';

interface BacktestArgs {
  file: string;
  initialCapital: number;
  feeFraction: number;
  slippageFraction: number;
  priceTick: string | null;
  quantityTick: string | null;
  minOrderBase: string | null;
  outFile: string | null;
}

function fail(msg: string): never {
  throw new Error(msg);
}

function parsePositiveNumber(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a finite number (got "${value}")`);
  if (n < 0) throw new Error(`${flag} must be >= 0 (got "${value}")`);
  return n;
}

function parseArgs(args: string[]): BacktestArgs {
  let file = '';
  let initialCapital = 10000;
  let feeFraction = 0.002;
  let slippageFraction = 0;
  let priceTick: string | null = null;
  let quantityTick: string | null = null;
  let minOrderBase: string | null = null;
  let outFile: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--initial-capital') initialCapital = parsePositiveNumber(a, args[++i]);
    else if (a === '--fee') feeFraction = parsePositiveNumber(a, args[++i]);
    else if (a === '--slippage') slippageFraction = parsePositiveNumber(a, args[++i]);
    else if (a === '--price-tick') priceTick = args[++i] ?? null;
    else if (a === '--quantity-tick') quantityTick = args[++i] ?? null;
    else if (a === '--min-order-base') minOrderBase = args[++i] ?? null;
    else if (a === '--out') outFile = args[++i] ?? null;
    else if (!a.startsWith('--')) file = a;
    else fail(`unknown flag "${a}"`);
  }
  if (!file) fail('usage: bot backtest <candles.json> [--initial-capital N] [--fee F] [--slippage S] [--price-tick P] [--quantity-tick Q] [--min-order-base B] [--out FILE]');
  if (priceTick === null) fail('--price-tick is required (the simulator never invents a price tick)');
  if (quantityTick === null) fail('--quantity-tick is required (the simulator never invents a quantity tick)');
  return { file, initialCapital, feeFraction, slippageFraction, priceTick, quantityTick, minOrderBase, outFile };
}

export const backtestCommand: CommandHandler = async (args): Promise<number> => {
  let opts: BacktestArgs;
  try {
    opts = parseArgs(args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Argument error: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

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

  const symbol = candles[0]?.symbol || cfg.tradingPairs[0]!;
  const quote = symbol.split('/')[1]!;

  const marketConstraints: BacktestMarketConstraints = {
    priceTick: Money.fromString(opts.priceTick!),
    quantityTick: Money.fromString(opts.quantityTick!),
    minOrderBase: opts.minOrderBase !== null ? Money.fromString(opts.minOrderBase) : null,
  };

  const btConfig: BacktestConfig = {
    symbol,
    timeframe: cfg.timeframe,
    initialCash: Money.fromNumber(opts.initialCapital),
    quoteCurrency: quote,
    feeModel: { kind: 'rate', currency: 'quote', rate: opts.feeFraction },
    slippageFraction: opts.slippageFraction,
    marketConstraints,
  };

  let result;
  try {
    result = runBacktest({
      candles,
      config: btConfig,
      createStrategy: () => buildStrategy(cfg),
      createRiskManager: () => buildRiskManager(cfg),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Backtest failed: ' + message);
    return 1;
  }

  const m = result.metrics;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  // eslint-disable-next-line no-console
  console.log('\n' + result.simulationLabel);
  // eslint-disable-next-line no-console
  console.log('Backtest result (' + symbol + ', ' + cfg.timeframe + ')');
  // eslint-disable-next-line no-console
  console.log('  Bar count:        ' + m.barCount);
  // eslint-disable-next-line no-console
  console.log('  Data range:       ' + new Date(result.dataStartMs ?? 0).toISOString() + ' -> ' + new Date(result.dataEndMs ?? 0).toISOString());
  // eslint-disable-next-line no-console
  console.log('  Price tick:       ' + result.marketConstraints.priceTick.toString() + ' (explicit)');
  // eslint-disable-next-line no-console
  console.log('  Quantity tick:    ' + result.marketConstraints.quantityTick.toString() + ' (explicit)');
  // eslint-disable-next-line no-console
  console.log('  Min order base:   ' + (result.marketConstraints.minOrderBase === null ? 'none' : result.marketConstraints.minOrderBase.toString()));
  // eslint-disable-next-line no-console
  console.log('  Fee model:        ' + result.feeModel.currency + '-' + result.feeModel.kind + ' @ ' + result.feeModel.rate);
  // eslint-disable-next-line no-console
  console.log('  Slippage:         ' + result.slippageFraction);
  // eslint-disable-next-line no-console
  console.log('  Starting capital: ' + m.startingCapital.toString());
  // eslint-disable-next-line no-console
  console.log('  Ending capital:   ' + m.endingCapital.toString());
  // eslint-disable-next-line no-console
  console.log('  Total P&L:        ' + m.absolutePnl.toString());
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
  console.log('  Gross profit:     ' + m.grossProfit.toString());
  // eslint-disable-next-line no-console
  console.log('  Gross loss:       ' + m.grossLoss.toString());
  // eslint-disable-next-line no-console
  console.log('  Fees paid:        ' + m.feesPaid.toString());
  // eslint-disable-next-line no-console
  console.log('  Peak equity:      ' + m.peakEquity.toString());
  // eslint-disable-next-line no-console
  console.log('  Max drawdown:     ' + pct(m.maxDrawdownFraction));
  // eslint-disable-next-line no-console
  console.log('  Largest win:      ' + m.largestWin.toString());
  // eslint-disable-next-line no-console
  console.log('  Largest loss:     ' + m.largestLoss.toString());
  // eslint-disable-next-line no-console
  console.log('  Max exposure:     ' + m.maxExposure.toString());
  // eslint-disable-next-line no-console
  console.log('  Rejections:       ' + result.rejections.length);
  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      // eslint-disable-next-line no-console
      console.log('  Warning:          ' + w);
    }
  }
  // eslint-disable-next-line no-console
  console.log('\n  NOTE: Historical simulation only; not a prediction of future performance.');

  if (opts.outFile) {
    writeFileSync(opts.outFile, JSON.stringify(result, null, 2));
    // eslint-disable-next-line no-console
    console.log('  Wrote JSON report to ' + opts.outFile);
  }

  return 0;
};
