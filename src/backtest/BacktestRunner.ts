/**
 * BacktestRunner — replays historical candles through the strategy -> risk ->
 * execution pipeline with simulated execution.
 *
 * This is a structured, honest backtest:
 *   - Strategy is evaluated exactly as in live/paper (strategy context built
 *     from the candle series up to the current candle).
 *   - RiskManager gates and sizes each order (fail-closed on unknowns).
 *   - Execution fills at the candle's close price with configurable fee and
 *     slippage, respecting the long-only, no-short constraint via Portfolio.
 *   - Portfolio math is exact Money (fixed-point BigInt).
 *
 * Simplifications (documented, not hidden): fills assume the full requested
 * quantity executes at the close price (no partial fills / no intra-candle
 * price path), and market info for sizing uses the candle's close as both the
 * reference price and the last price.
 *
 * RESULTS ARE HISTORICAL SIMULATION, NOT A PREDICTION OF FUTURE PERFORMANCE.
 */

import { Money } from '../money/Money.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { StrategyContext } from '../strategy/StrategyContext.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { RiskContext } from '../risk/RiskContext.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type { Balance, Candle, MarketInfo, Timeframe } from '../types.js';
import type {
  BacktestConfig,
  BacktestRejection,
  BacktestResult,
  BacktestTrade,
} from './types.js';
import { computeMetrics } from './report.js';

const FRACTION_SCALE = 1_000_000_000n;

export class BacktestRunner {
  constructor(
    private readonly strategy: Strategy,
    private readonly riskManager: RiskManager,
  ) {}

  run(candles: Candle[], config: BacktestConfig): BacktestResult {
    const symbolsToUse = candles.length > 0 ? candles[0]!.symbol : config.symbol;
    const sorted = [...candles].sort((a, b) => a.timestampMs - b.timestampMs);
    const capped = config.maxCandles ? sorted.slice(0, config.maxCandles) : sorted;

    const initialCash = config.initialCash;
    const initial = new Map<string, Money>([[config.quoteCurrency, initialCash]]);
    let portfolio = Portfolio.empty(initial);
    const peak = { value: initialCash };
    const trades: BacktestTrade[] = [];
    const rejections: BacktestRejection[] = [];
    const equityCurve: BacktestResult['equityCurve'] = [];
    const realizedPnlValues: Money[] = [];

    const fillOnClose = (side: 'BUY' | 'SELL', quantity: Money, price: Money, nowMs: number) => {
      const slippageFactor = side === 'BUY'
        ? 1 + config.slippageFraction
        : 1 - config.slippageFraction;
      const fillPrice = exactFraction(price, slippageFactor);
      const notional = quantity.mul(fillPrice);
      const fee = exactFraction(notional, config.feeFraction);
      let realizedPnl = Money.zero();
      if (side === 'SELL') {
        const pos = portfolio.position(symbolsToUse);
        if (pos) {
          realizedPnl = quantity.mul(fillPrice.sub(pos.averageEntryPrice)).sub(fee);
        }
      }
      portfolio = portfolio.applyFill(symbolsToUse, side, quantity, fillPrice, fee);
      trades.push({ index: 0, side, quantity, price: fillPrice, fee, notional, timestampMs: nowMs });
      if (side === 'SELL') realizedPnlValues.push(realizedPnl);
    };

    for (let i = 0; i < capped.length; i++) {
      const candle = capped[i]!;
      const nowMs = candle.timestampMs;
      const series = capped.slice(0, i + 1);
      const close = candle.close;

      const strategyCtx = this.buildStrategyContext(symbolsToUse, series, candle, config.timeframe, portfolio);
      const signal = this.strategy.evaluate(strategyCtx);
      if (signal.type !== 'HOLD') {
        const riskCtx = this.buildRiskContext(symbolsToUse, signal, nowMs, close, portfolio, config);
        const decision = this.riskManager.evaluate(riskCtx);
        if (decision.approved) {
          fillOnClose(decision.side, decision.quantity, close, nowMs);
        } else if (decision.side) {
          rejections.push({ index: i, side: decision.side, reason: decision.reason, timestampMs: nowMs });
        }
      }

      // Record equity (cash + market value of positions at current close).
      const prices = new Map<string, Money>([[symbolsToUse, close]]);
      const mtm = portfolio.markToMarket(prices);
      if (mtm.equity.compareTo(peak.value) > 0) peak.value = mtm.equity;
      equityCurve.push({ timestampMs: nowMs, equity: mtm.equity });
    }

    const finalPrices = new Map<string, Money>([[
      symbolsToUse,
      capped.length > 0 ? capped[capped.length - 1]!.close : Money.zero(),
    ]]);
    const finalMtm = portfolio.markToMarket(finalPrices);
    const finalQuoteCash = portfolio.cash(config.quoteCurrency);
    const finalPositionQty = portfolio.position(symbolsToUse)?.quantity ?? Money.zero();

    const metrics = computeMetrics({
      candles: capped.length,
      startingCapital: initialCash,
      endingCapital: finalMtm.equity,
      feesPaid: portfolio.stateModel.totalFees,
      realizedPnl: portfolio.stateModel.realizedPnl,
      trades,
      realizedPnlValues,
      equityCurve,
      peak,
      finalEquity: finalMtm.equity,
    });

    return {
      config,
      metrics,
      equityCurve,
      trades,
      rejections,
      finalQuoteCash,
      finalPositionQty,
    };
  }

  private buildStrategyContext(
    symbol: string,
    series: Candle[],
    current: Candle,
    timeframe: Timeframe,
    portfolio: Portfolio,
  ): StrategyContext {
    const position = portfolio.position(symbol);
    return {
      nowMs: current.timestampMs,
      symbol,
      ticker: {
        symbol,
        bid: current.close,
        ask: current.close,
        last: current.close,
        open: current.open,
        high: current.high,
        low: current.low,
        baseVolume: current.baseVolume,
        quoteVolume: current.quoteVolume ?? null,
        timestampMs: current.timestampMs,
      },
      candles: series,
      timeframe,
      position: {
        symbol,
        quantity: position?.quantity ?? Money.zero(),
        averageEntryPrice: position?.averageEntryPrice ?? null,
        realizedPnl: position?.realizedPnl ?? Money.zero(),
      },
      insufficientData: series.length < this.strategy.warmupCandles,
    };
  }

  private buildRiskContext(
    symbol: string,
    signal: ReturnType<Strategy['evaluate']>,
    nowMs: number,
    price: Money,
    portfolio: Portfolio,
    config: BacktestConfig,
  ): RiskContext {
    const prices = new Map<string, Money>([[symbol, price]]);
    const mtm = portfolio.markToMarket(prices);
    const position = portfolio.position(symbol);
    const quote = config.quoteCurrency;
    const quoteBalance: Balance = {
      currency: quote,
      total: portfolio.cash(quote),
      available: portfolio.cash(quote),
      held: Money.zero(),
    };
    return {
      symbol,
      signal,
      nowMs,
      marketDataTimestampMs: nowMs,
      price,
      marketInfo: backtestMarketInfo(symbol),
      quoteBalance,
      portfolioValue: mtm.equity,
      peakPortfolioValue: portfolio.stateModel.peakEquity,
      portfolioExposure: portfolio.exposure(prices),
      currentPosition: position?.quantity ?? Money.zero(),
      realizedPnlToday: portfolio.stateModel.realizedPnl,
      unrealizedPnlToday: mtm.unrealizedPnl,
    };
  }
}

/**
 * Synthetic market metadata for the simulated execution. The backtest has no
 * real exchange, so we supply a reasonable MarketInfo matching the NDAX-style
 * tick grid that production config expects (price tick 0.01, quantity tick
 * 1e-8, flat 0.2% fee).
 */
function backtestMarketInfo(symbol: string): MarketInfo {
  return {
    symbol,
    exchangeId: 'backtest',
    priceTick: Money.fromString('0.01'),
    basePrecision: 8,
    quotePrecision: 2,
    quantityTick: Money.fromString('0.00000001'),
    minOrderBase: Money.zero(),
    minOrderQuote: Money.fromString('1'),
    supportsMarketOrders: true,
    feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  };
}

function exactFraction(money: Money, fraction: number): Money {
  const num = BigInt(Math.round(fraction * Number(FRACTION_SCALE)));
  return money.mulFraction(num, FRACTION_SCALE);
}
