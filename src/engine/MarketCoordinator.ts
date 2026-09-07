/**
 * MarketCoordinator — evaluates multiple eligible markets and selects at most
 * one trade per cycle.
 *
 * The coordinator is the multi-asset decision layer. For each eligible market it:
 *   1. fetches/maintains market data and the bot-MANAGED position,
 *   2. updates strategy state and evaluates a signal,
 *   3. (for non-HOLD) builds a RiskContext and runs the RiskManager,
 *   4. collects approved opportunities.
 * It then **ranks** approved opportunities deterministically and returns a single
 * `selected` trade (or none). The engine executes ONLY that one — never multiple
 * orders from one cycle, even if several markets signal simultaneously.
 *
 * Safety properties:
 *   - It never manufactures a signal: it only relays the strategy's output.
 *   - It never bypasses RiskManager: a candidate must be risk-approved.
 *   - It never opens new exposure when the managed portfolio is at max open
 *     positions (RiskManager enforces via `openManagedPositionCount`).
 *   - External holdings never appear as a bot position (managed-only).
 *
 * Ranking policy (deterministic, documented in docs/DECISIONS.md):
 *   1. Risk-reducing SELL exits take precedence over new BUYs (exit before
 *      entry), ordered by symbol ascending.
 *   2. If no SELL is approved, BUYs are ordered by lower relative spread
 *      (better liquidity) ascending, then by symbol ascending — a fully
 *      deterministic tie-break, never object-iteration order.
 */

import type { Strategy } from '../strategy/Strategy.js';
import type { StrategyContext } from '../strategy/StrategyContext.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { RiskContext } from '../risk/RiskContext.js';
import type { RiskApproval, RiskDecision } from '../risk/Reason.js';
import type { Portfolio } from '../portfolio/Portfolio.js';
import type { Candle, MarketInfo, Ticker, Timeframe } from '../types.js';
import type { Signal } from '../strategy/Signal.js';
import { Money } from '../money/Money.js';
import { evaluateFreshness, type FreshnessPolicy } from '../marketdata/freshness.js';

export interface CoordinatorMarketSource {
  /** Market metadata per symbol (null => unknown, risk fails closed). */
  getMarketInfo: (symbol: string) => MarketInfo | null;
  /** Latest ticker per symbol (null => unknown, risk fails closed). */
  getTicker: (symbol: string) => Ticker | null;
  /** Candle series per symbol for the strategy timeframe. */
  getCandles: (symbol: string, timeframe: Timeframe) => Candle[];
}

export interface EvaluatedMarket {
  symbol: string;
  /** The strategy's signal for this cycle (always present). */
  signal: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  signalReason: string | null;
  /** The risk decision (null when the signal was HOLD or skipped). */
  decision: RiskDecision | null;
  /** True when the market was skipped before strategy evaluation. */
  skipped: boolean;
  skipReason: string | null;
  /** Relative spread (ask-bid)/mid for ranking; null if not determinable. */
  relativeSpread: number | null;
}

/** An approved, ranked trade ready for execution. */
export interface SelectedTrade {
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Risk-approved quantity in base units. */
  quantity: Money;
  /** Reference price used to size (ask for BUY, bid for SELL). */
  referencePrice: Money;
  estimatedNotional: Money;
  decision: RiskApproval;
  relativeSpread: number | null;
}

export interface CoordinatorResult {
  evaluated: EvaluatedMarket[];
  /** The single trade to execute this cycle, or null => NO TRADE. */
  selected: SelectedTrade | null;
}

export interface CoordinatorDeps {
  strategy: Strategy;
  riskManager: RiskManager;
  /**
   * Accessor for the CURRENT managed portfolio. The engine holds a live,
   * immutable `Portfolio` that is replaced on each fill, so the coordinator must
   * read it fresh each cycle rather than caching one instance.
   */
  getPortfolio: () => Portfolio;
  timeframe: Timeframe;
  /** Currency extraction already inferred from the symbol's quote part. */
  marketSource: CoordinatorMarketSource;
  /**
   * F-8: the freshness policy used to decide whether a non-candidate managed
   * position's cached quote is fresh enough to value portfolio equity/exposure.
   * This is the SAME policy the RiskManager applies to the candidate quote, so a
   * stale managed-position price can never understate exposure and let an
   * oversized BUY through. Exchanged-agnostic: the policy is a pure age/skew
   * config, not an NDAX-specific format.
   */
  freshnessPolicy: FreshnessPolicy;
}

export class MarketCoordinator {
  private readonly deps: CoordinatorDeps;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate an ordered list of eligible symbols and return up to one selected
   * trade. Symbols are normalized+sorted so iteration is deterministic.
   */
  evaluate(symbols: string[], nowMs: number): CoordinatorResult {
    const { strategy, riskManager, timeframe, marketSource, getPortfolio } = this.deps;
    const ordered = [...new Set(symbols)].sort();

    const evaluated: EvaluatedMarket[] = [];
    const candidates: SelectedTrade[] = [];

    for (const symbol of ordered) {
      const marketInfo = marketSource.getMarketInfo(symbol);
      const ticker = marketSource.getTicker(symbol);
      const portfolio = getPortfolio();

      if (marketInfo === null) {
        evaluated.push({
          symbol,
          signal: 'HOLD',
          signalType: 'HOLD',
          signalReason: null,
          decision: null,
          skipped: true,
          skipReason: 'UNKNOWN_MARKET_INFO',
          relativeSpread: null,
        });
        continue;
      }

      const candles = marketSource.getCandles(symbol, timeframe);
      const managed = portfolio.position(symbol) ?? null;

      const strategyCtx: StrategyContext = {
        nowMs,
        symbol,
        ticker,
        candles,
        timeframe,
        position: {
          symbol,
          quantity: managed?.quantity ?? Money.zero(),
          averageEntryPrice: managed?.averageEntryPrice ?? null,
          realizedPnl: managed?.realizedPnl ?? Money.zero(),
        },
        insufficientData: candles.length < strategy.warmupCandles,
      };

      const signal = strategy.evaluate(strategyCtx);
      const spread = relativeSpreadOf(ticker);

      if (signal.type === 'HOLD') {
        evaluated.push({
          symbol,
          signal: 'HOLD',
          signalType: 'HOLD',
          signalReason: signal.reason ?? null,
          decision: null,
          skipped: false,
          skipReason: null,
          relativeSpread: spread,
        });
        continue;
      }

      // Build the RiskContext from MANAGED state (never external), with the
      // deployable quote net of reserves and the managed open-position count.
      const riskCtx = this.buildRiskContext(symbol, signal, nowMs, marketInfo, ticker);
      const decision = riskManager.evaluate(riskCtx);

      evaluated.push({
        symbol,
        signal: signal.type,
        signalType: signal.type,
        signalReason: signal.reason ?? null,
        decision,
        skipped: false,
        skipReason: null,
        relativeSpread: spread,
      });

      if (decision.approved) {
        candidates.push({
          symbol,
          side: decision.side,
          quantity: decision.quantity,
          referencePrice: decision.price,
          estimatedNotional: decision.estimatedNotional,
          decision,
          relativeSpread: spread,
        });
      }
    }

    return { evaluated, selected: this.selectOne(candidates) };
  }

  private buildRiskContext(
    symbol: string,
    signal: Signal,
    nowMs: number,
    marketInfo: MarketInfo,
    ticker: Ticker | null,
  ): RiskContext {
    const { getPortfolio, marketSource } = this.deps;
    const portfolio = getPortfolio();
    const quote = symbol.split('/')[1] ?? '';
    const managed = portfolio.position(symbol) ?? null;

    // F-2 build a COMPLETE portfolio-wide price map so portfolio equity/exposure
    // account for EVERY managed position, not just the candidate symbol. External
    // holdings are excluded (they live in `externalSnapshot`, never `positions`).
    const priceMap = new Map<string, Money>();

    // 1) The candidate symbol's own price (this is what the risk decision sizes
    //    and whose freshness the RiskManager validates via marketData timestamps).
    const refForMark = ticker?.last ?? ticker?.ask ?? ticker?.bid ?? null;
    if (refForMark) priceMap.set(symbol, refForMark);

    // 2) Every OTHER existing managed position. If a managed position cannot be
    //    valued, we FAIL CLOSED (portfolioValue/exposure = null) rather than
    //    silently treating it as zero, so the exposure cap can never be
    //    under-counted. No new exchange calls: `getTicker` reads the polled
    //    market-data cache.
    //    F-8: freshness is checked for each managed asset too. A MISSING price
    //    already fails closed (F-2). A STALE cached quote ALSO fails closed,
    //    otherwise an old/low price could under-state exposure and let an
    //    oversized BUY through. The candidate itself is validated by the
    //    RiskManager, so it is excluded here.
    let valuationUnknown = false;
    for (const pos of portfolio.stateModel.positions.values()) {
      if (pos.symbol === symbol || priceMap.has(pos.symbol)) continue;
      const posTicker = marketSource.getTicker(pos.symbol);
      const posPrice = posTicker?.last ?? posTicker?.ask ?? posTicker?.bid ?? null;
      if (posPrice === null) {
        valuationUnknown = true;
        continue;
      }
      const posFreshness = evaluateFreshness({
        nowMs,
        quoteTimestampMs: posTicker?.timestampMs ?? null,
        observedAtMs: posTicker?.observedAtMs ?? null,
        policy: this.deps.freshnessPolicy,
      });
      if (!posFreshness.fresh) {
        valuationUnknown = true;
        continue;
      }
      priceMap.set(pos.symbol, posPrice);
    }

    const mtm = valuationUnknown ? null : portfolio.markToMarket(priceMap);
    const refPrice = signal.type === 'BUY'
      ? (ticker?.ask ?? ticker?.last ?? null)
      : (ticker?.bid ?? ticker?.last ?? null);

    const quoteTotal = portfolio.cash(quote);
    const quoteBalance = {
      currency: quote,
      total: quoteTotal,
      available: portfolio.deployableQuote(quote),
      held: portfolio.reserved(quote),
    };

    return {
      symbol,
      signal: { symbol, type: signal.type, ...(signal.reason ? { reason: signal.reason } : {}), timestampMs: nowMs },
      nowMs,
      marketDataTimestampMs: ticker?.timestampMs ?? null,
      marketDataObservedAtMs: ticker?.observedAtMs ?? null,
      price: refPrice,
      marketInfo,
      quoteBalance,
      deployableQuote: portfolio.deployableQuote(quote),
      portfolioValue: mtm ? mtm.equity : null,
      peakPortfolioValue: portfolio.stateModel.peakEquity,
      portfolioExposure: mtm ? portfolio.exposure(priceMap) : null,
      currentPosition: managed?.quantity ?? Money.zero(),
      externalPosition: portfolio.external(symbol),
      openManagedPositionCount: portfolio.managedOpenCount(),
      realizedPnlToday: portfolio.stateModel.realizedPnl,
      unrealizedPnlToday: mtm ? mtm.unrealizedPnl : null,
    };
  }

  private selectOne(candidates: SelectedTrade[]): SelectedTrade | null {
    if (candidates.length === 0) return null;

    // 1) Risk-reducing SELL exits take precedence (exit before entry).
    const sells = candidates
      .filter((c) => c.side === 'SELL')
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (sells.length > 0) return sells[0]!;

    // 2) BUYs ranked by lower relative spread, then symbol asc (deterministic).
    const buys = candidates
      .filter((c) => c.side === 'BUY')
      .sort((a, b) => {
        const sa = a.relativeSpread ?? Number.POSITIVE_INFINITY;
        const sb = b.relativeSpread ?? Number.POSITIVE_INFINITY;
        if (sa !== sb) return sa - sb;
        return a.symbol.localeCompare(b.symbol);
      });
    return buys[0] ?? null;
  }
}

/** Relative spread (ask-bid)/mid; null when bid/ask are unavailable. */
function relativeSpreadOf(ticker: Ticker | null): number | null {
  if (!ticker) return null;
  const bid = ticker.bid;
  const ask = ticker.ask;
  if (!bid || !ask || !bid.isPositive() || !ask.isPositive()) return null;
  if (ask.compareTo(bid) <= 0) return null;
  const midNumerator = bid.toNumber() + ask.toNumber();
  if (midNumerator <= 0) return null;
  const spread = ask.sub(bid);
  return spread.toNumber() / midNumerator;
}
