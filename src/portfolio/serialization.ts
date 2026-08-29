/**
 * Portfolio JSON serialization (for persistence / logging).
 *
 * `Money` is stored as its canonical decimal string so values survive a restart
 * exactly and are human-readable in a state file.
 */

import { Money } from '../money/Money.js';
import type { PortfolioModel, PaperPosition } from './types.js';

interface PositionJson {
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  feesPaid: string;
}

export interface PortfolioJsonV1 {
  version: 1;
  cash: Record<string, string>;
  positions: Record<string, PositionJson>;
  peakEquity: string;
  realizedPnl: string;
  totalFees: string;
}

export function serializePortfolio(state: PortfolioModel): PortfolioJsonV1 {
  const cash: Record<string, string> = {};
  for (const [cur, amount] of state.cash) cash[cur] = amount.toString();
  const positions: Record<string, PositionJson> = {};
  for (const [sym, p] of state.positions) {
    const pj: PositionJson = {
      symbol: p.symbol,
      quantity: p.quantity.toString(),
      averageEntryPrice: p.averageEntryPrice.toString(),
      costBasis: p.costBasis.toString(),
      realizedPnl: p.realizedPnl.toString(),
      feesPaid: p.feesPaid.toString(),
    };
    positions[sym] = pj;
  }
  return {
    version: 1,
    cash,
    positions,
    peakEquity: state.peakEquity.toString(),
    realizedPnl: state.realizedPnl.toString(),
    totalFees: state.totalFees.toString(),
  };
}

export function deserializePortfolio(json: PortfolioJsonV1): PortfolioModel {
  const cash = new Map<string, Money>();
  for (const [cur, amount] of Object.entries(json.cash)) cash.set(cur, Money.fromString(amount));
  const positions = new Map<string, PaperPosition>();
  for (const [sym, p] of Object.entries(json.positions)) {
    positions.set(sym, {
      symbol: p.symbol,
      quantity: Money.fromString(p.quantity),
      averageEntryPrice: Money.fromString(p.averageEntryPrice),
      costBasis: Money.fromString(p.costBasis),
      realizedPnl: Money.fromString(p.realizedPnl),
      feesPaid: Money.fromString(p.feesPaid),
    });
  }
  return {
    cash,
    positions,
    peakEquity: Money.fromString(json.peakEquity),
    realizedPnl: Money.fromString(json.realizedPnl),
    totalFees: Money.fromString(json.totalFees),
  };
}
