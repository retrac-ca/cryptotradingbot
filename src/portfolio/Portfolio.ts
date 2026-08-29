/**
 * Portfolio — tracks cash, positions, average entry price, cost basis, and P&L.
 *
 * All math is `Money` (fixed-point BigInt). Fills are applied via `applyFill`,
 * which handles both opening/scaling a long (BUY) and reducing/closing a long
 * (SELL), updating average entry price, cost basis, realized P&L, and fees.
 */

import { Money } from '../money/Money.js';
import type { OrderSide } from '../order.js';
import type { PortfolioModel, PaperPosition } from './types.js';

export class Portfolio {
  private readonly state: PortfolioModel;

  private constructor(state: PortfolioModel) {
    this.state = state;
  }

  /** Create an empty portfolio seeded with initial cash by currency. */
  static empty(initialCash: Map<string, Money> = new Map()): Portfolio {
    return new Portfolio({
      cash: new Map(initialCash),
      positions: new Map(),
      peakEquity: Portfolio.equityOf({ cash: new Map(initialCash), positions: new Map() }),
      realizedPnl: Money.zero(),
      totalFees: Money.zero(),
    });
  }

  /** Rebuild from a persisted model (restart recovery). */
  static fromModel(state: PortfolioModel): Portfolio {
    return new Portfolio(state);
  }

  /** Current state (read-only). */
  get stateModel(): PortfolioModel {
    return this.state;
  }

  cash(currency: string): Money {
    return this.state.cash.get(currency) ?? Money.zero();
  }

  position(symbol: string): PaperPosition | null {
    return this.state.positions.get(symbol) ?? null;
  }

  /** Total equity = cash + market value of all positions (quote-denominated). */
  static equityOf(m: Pick<PortfolioModel, 'cash' | 'positions'>): Money {
    let total = Money.zero();
    for (const amount of m.cash.values()) total = total.add(amount);
    for (const pos of m.positions.values()) {
      total = total.add(pos.costBasis); // positions carried at cost for baseline equity
    }
    return total;
  }

  /**
   * Apply a fill to the portfolio.
   *
   * @param symbol        e.g. "BTC/CAD"
   * @param side          BUY or SELL
   * @param quantity      filled base quantity (must be > 0)
   * @param price         fill price (quote per base unit)
   * @param fee           fee in quote currency
   * @returns the updated portfolio (new instance)
   */
  applyFill(symbol: string, side: OrderSide, quantity: Money, price: Money, fee: Money): Portfolio {
    const quote = symbol.split('/')[1]!;

    if (!quantity.isPositive()) {
      throw new Error('Portfolio.applyFill: fill quantity must be positive');
    }

    const state = this.cloneState();
    const notional = quantity.mul(price);

    if (side === 'BUY') {
      const cost = notional.add(fee);
      const existing = state.positions.get(symbol);
      if (existing) {
        const newQty = existing.quantity.add(quantity);
        const newCostBasis = existing.costBasis.add(cost);
        state.positions.set(symbol, {
          ...existing,
          quantity: newQty,
          costBasis: newCostBasis,
          averageEntryPrice: newCostBasis.div(newQty),
          feesPaid: existing.feesPaid.add(fee),
        });
      } else {
        state.positions.set(symbol, {
          symbol,
          quantity,
          costBasis: cost,
          averageEntryPrice: cost.div(quantity),
          realizedPnl: Money.zero(),
          feesPaid: fee,
        });
      }
      state.cash.set(quote, state.cash.get(quote)!.sub(cost));
      state.totalFees = state.totalFees.add(fee);
    } else {
      // SELL — reduce/close a long position.
      const existing = state.positions.get(symbol);
      if (!existing || existing.quantity.isZero()) {
        throw new Error('Portfolio.applyFill: SELL with no held position');
      }
      if (quantity.compareTo(existing.quantity) > 0) {
        throw new Error('Portfolio.applyFill: SELL quantity exceeds held position (cannot go short)');
      }
      const proceeds = notional.sub(fee);
      const realized = quantity.mul(price.sub(existing.averageEntryPrice)).sub(fee);
      const remainingQty = existing.quantity.sub(quantity);
      const remainingCostBasis = remainingQty.isZero()
        ? Money.zero()
        : existing.costBasis.sub(existing.averageEntryPrice.mul(quantity));
      state.positions.set(symbol, {
        ...existing,
        quantity: remainingQty,
        costBasis: remainingCostBasis,
        realizedPnl: existing.realizedPnl.add(realized),
        feesPaid: existing.feesPaid.add(fee),
      });
      if (state.positions.get(symbol)!.quantity.isZero()) {
        state.positions.delete(symbol);
      }
      state.cash.set(quote, state.cash.get(quote)!.add(proceeds));
      state.realizedPnl = state.realizedPnl.add(realized);
      state.totalFees = state.totalFees.add(fee);
    }

    // Track peak equity (cost-basis baseline) for drawdown.
    const equity = Portfolio.equityOf(state);
    if (equity.compareTo(state.peakEquity) > 0) {
      state.peakEquity = equity;
    }

    return new Portfolio(state);
  }

  /**
   * Recompute equity/unrealized P&L using a current market price per symbol.
   * Returns current equity and unrealized P&L (quote) for open positions.
   */
  markToMarket(prices: Map<string, Money>): { equity: Money; unrealizedPnl: Money } {
    let equity = Money.zero();
    for (const amount of this.state.cash.values()) equity = equity.add(amount);
    let unrealized = Money.zero();
    for (const pos of this.state.positions.values()) {
      const price = prices.get(pos.symbol);
      if (!price) continue; // cannot mark this symbol
      const mv = pos.quantity.mul(price);
      equity = equity.add(mv);
      unrealized = unrealized.add(pos.quantity.mul(price.sub(pos.averageEntryPrice)));
    }
    return { equity, unrealizedPnl: unrealized };
  }

  /** Sum notional market value of all open positions (quote) given prices. */
  exposure(prices: Map<string, Money>): Money {
    let total = Money.zero();
    for (const pos of this.state.positions.values()) {
      const price = prices.get(pos.symbol);
      if (price) total = total.add(pos.quantity.mul(price));
    }
    return total;
  }

  private cloneState(): PortfolioModel {
    return {
      cash: new Map(this.state.cash),
      positions: new Map(
        [...this.state.positions].map(([k, p]) => [k, { ...p }]),
      ),
      peakEquity: this.state.peakEquity,
      realizedPnl: this.state.realizedPnl,
      totalFees: this.state.totalFees,
    };
  }
}
