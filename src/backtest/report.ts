/**
 * Backtest metrics computation (Backtesting V1).
 *
 * Converts a raw backtest run into the required performance report. All
 * accounting is exact `Money`; ratios are computed only for display. Division by
 * zero is guarded (zero starting capital / zero closed trades / zero peak).
 */

import { Money } from '../money/Money.js';
import type { BacktestMetrics, BacktestTrade } from './types.js';

export interface MetricsInput {
  barCount: number;
  startingCapital: Money;
  endingCapital: Money;
  trades: BacktestTrade[];
  equityCurve: { timestampMs: number; equity: Money }[];
  peakEquity: Money;
  maxExposure: Money;
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const absolutePnl = input.endingCapital.sub(input.startingCapital);
  const totalReturnFraction = input.startingCapital.isZero()
    ? 0
    : absolutePnl.div(input.startingCapital).toNumber();

  // Trade statistics over CLOSED trades (SELLs with a realized P&L).
  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfit = Money.zero();
  let grossLoss = Money.zero();
  let largestWin = Money.zero();
  let largestLoss = Money.zero();
  let feesPaid = Money.zero();

  for (const t of input.trades) {
    feesPaid = feesPaid.add(t.fee);
    const pnl = t.realizedPnl;
    if (pnl === null) continue; // an open (BUY) trade has no realized P&L yet
    if (pnl.isPositive()) {
      winningTrades += 1;
      grossProfit = grossProfit.add(pnl);
      if (pnl.compareTo(largestWin) > 0) largestWin = pnl;
    } else if (pnl.isNegative()) {
      losingTrades += 1;
      grossLoss = grossLoss.add(pnl.negate());
      if (pnl.compareTo(largestLoss) < 0) largestLoss = pnl;
    }
  }

  const closedTrades = winningTrades + losingTrades;
  const winRate = closedTrades === 0 ? 0 : winningTrades / closedTrades;

  // Max drawdown from the equity curve (peak-to-trough, as a fraction of peak).
  let maxDrawdownFraction = 0;
  let runningPeak = input.peakEquity;
  for (const point of input.equityCurve) {
    if (point.equity.compareTo(runningPeak) > 0) runningPeak = point.equity;
    if (!runningPeak.isZero()) {
      const dd = runningPeak.sub(point.equity).div(runningPeak).toNumber();
      if (dd > maxDrawdownFraction) maxDrawdownFraction = dd;
    }
  }

  return {
    barCount: input.barCount,
    startingCapital: input.startingCapital,
    endingCapital: input.endingCapital,
    absolutePnl,
    totalReturnFraction,
    tradeCount: input.trades.length,
    winningTrades,
    losingTrades,
    winRate,
    grossProfit,
    grossLoss,
    feesPaid,
    maxDrawdownFraction,
    peakEquity: input.peakEquity,
    largestWin,
    largestLoss,
    maxExposure: input.maxExposure,
  };
}
