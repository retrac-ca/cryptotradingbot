/**
 * Backtest metrics computation.
 *
 * Converts a raw backtest run into the required performance report: starting /
 * ending capital, total return, trade count, winning/losing trades and win
 * rate, realized P&L, fees, max drawdown, and largest win/loss.
 *
 * Max drawdown is computed over the equity curve (peak-to-trough of equity),
 * reported as a fraction of the peak.
 */

import { Money } from '../money/Money.js';
import type { BacktestMetrics, BacktestTrade } from './types.js';

export interface MetricsInput {
  candles: number;
  startingCapital: Money;
  endingCapital: Money;
  feesPaid: Money;
  realizedPnl: Money;
  trades: BacktestTrade[];
  /** Realized P&L per closed (SELL) trade, for win/loss statistics. */
  realizedPnlValues: Money[];
  equityCurve: { timestampMs: number; equity: Money }[];
  peak: { value: Money };
  finalEquity: Money;
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const totalReturnFraction = input.startingCapital.isZero()
    ? 0
    : input.endingCapital.sub(input.startingCapital).div(input.startingCapital).toNumber();

  // Win/loss stats over closed trades (realized P&L > 0 wins, < 0 losses).
  let winningTrades = 0;
  let losingTrades = 0;
  let largestWin = Money.zero();
  let largestLoss = Money.zero();
  for (const pnl of input.realizedPnlValues) {
    if (pnl.isPositive()) {
      winningTrades++;
      if (pnl.compareTo(largestWin) > 0) largestWin = pnl;
    } else if (pnl.isNegative()) {
      losingTrades++;
      if (pnl.compareTo(largestLoss) < 0) largestLoss = pnl;
    }
  }
  const closedTrades = input.realizedPnlValues.length;
  const winRate = closedTrades === 0 ? 0 : winningTrades / closedTrades;

  // Max drawdown from the equity curve.
  let maxDrawdownFraction = 0;
  let runningPeak = input.peak.value;
  for (const point of input.equityCurve) {
    if (point.equity.compareTo(runningPeak) > 0) runningPeak = point.equity;
    if (!runningPeak.isZero()) {
      const dd = runningPeak.sub(point.equity).div(runningPeak).toNumber();
      if (dd > maxDrawdownFraction) maxDrawdownFraction = dd;
    }
  }

  return {
    candles: input.candles,
    startingCapital: input.startingCapital,
    endingCapital: input.endingCapital,
    totalReturnFraction,
    tradeCount: input.trades.length,
    winningTrades,
    losingTrades,
    winRate,
    realizedPnl: input.realizedPnl,
    feesPaid: input.feesPaid,
    maxDrawdownFraction,
    largestWin,
    largestLoss,
  };
}
