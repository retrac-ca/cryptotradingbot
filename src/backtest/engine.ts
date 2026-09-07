/**
 * Backtest engine (Backtesting V1) — deterministic C1 event loop.
 *
 * Convention (no lookahead):
 *  - `Candle.timestampMs` is the candle END/CLOSE time.
 *  - Decision for bar `i` uses candles `[0..i]` (completed bars only) and
 *    evaluates the Strategy then the RiskManager at `close[i]` exactly once.
 *  - An approved order becomes an immutable pending intent.
 *  - The pending intent fills COMPLETELY at the next available bar's OPEN
 *    (`open[i+1]`) with deterministic slippage + tick normalization.
 *  - Fill-time safety checks only (no re-run of RiskManager, no re-sizing).
 *  - Equity is marked at `close[i]`.
 *
 * The engine receives FACTORIES (`createStrategy`, `createRiskManager`) and
 * constructs a FRESH instance of each ONCE per run — so state can never leak
 * between runs. It is a pure deterministic function of its inputs: no wall clock,
 * no randomness, no network, no persistence, no exchange writes.
 */

import { Money } from '../money/Money.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type { OrderSide } from '../order.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { StrategyContext, PositionView } from '../strategy/StrategyContext.js';
import type { RiskContext } from '../risk/RiskContext.js';
import type { MarketInfo, Timeframe } from '../types.js';
import type {
  BacktestConfig,
  BacktestRejection,
  BacktestResult,
  BacktestRunInput,
  BacktestTrade,
} from './types.js';
import { BacktestValidationError, validateCandles, validateConfig } from './validation.js';
import { computeQuoteFee } from './fee.js';
import { computeFillPrice } from './fill.js';
import { computeMetrics } from './report.js';

/** Interval (ms) for each supported timeframe, used to derive a bar's OPEN time. */
const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

interface PendingIntent {
  side: OrderSide;
  quantity: Money;
  signalBarIndex: number;
  decisionTsMs: number;
}

export function runBacktest(input: BacktestRunInput): BacktestResult {
  const { candles, config } = input;

  // Fail-closed: validate config/constraints first, then the candle series.
  validateConfig(config);

  const strategy = input.createStrategy();
  const riskManager = input.createRiskManager();

  const cv = validateCandles(candles);
  if (!cv.ok) {
    throw new BacktestValidationError(cv.reason ?? 'invalid candle data');
  }
  if (candles.length <= strategy.warmupCandles) {
    throw new BacktestValidationError(
      `insufficient candle data: ${candles.length} candles, but the strategy needs more than ${strategy.warmupCandles}` +
        ' to warm up and produce an executable signal',
    );
  }

  const symbol = config.symbol;
  const quote = config.quoteCurrency;
  const timeframe = config.timeframe;
  const mc = config.marketConstraints;
  const feeModel = config.feeModel;
  const slippage = config.slippageFraction;

  const warnings: string[] = [...cv.warnings];

  let portfolio = Portfolio.empty(new Map<string, Money>([[quote, config.initialCash]]));

  let pending: PendingIntent | null = null;
  const trades: BacktestTrade[] = [];
  const rejections: BacktestRejection[] = [];
  const equityCurve: BacktestResult['equityCurve'] = [];
  let seq = 0;
  const peak = { value: config.initialCash };
  let maxExposure = Money.zero();

  const marketInfo = buildMarketInfo(symbol, mc, feeModel.rate);

  // Timeframe interval for deriving a bar's open time from its end time.
  const intervalMs = TIMEFRAME_MS[timeframe] ?? 0;
  let sawGap = false;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    if (i > 0 && intervalMs > 0) {
      const delta = candle.timestampMs - candles[i - 1]!.timestampMs;
      if (delta !== intervalMs) sawGap = true;
    }

    // ---- Step 1: execute a pending intent at this bar's OPEN. ----
    if (pending !== null) {
      const p = pending;
      const openTimeMs = intervalMs > 0 ? candle.timestampMs - intervalMs : candle.timestampMs;
      const outcome = executePending(portfolio, candles[i]!, p, {
        symbol,
        quote,
        mc,
        slippage,
        feeModel,
        signalBarIndex: p.signalBarIndex,
        decisionTsMs: p.decisionTsMs,
        fillBarIndex: i,
        fillTimeMs: openTimeMs,
        seq,
      });
      seq = outcome.seq;
      if (outcome.trade) trades.push(outcome.trade);
      if (outcome.rejection) rejections.push(outcome.rejection);
      if (outcome.portfolio) portfolio = outcome.portfolio;
      pending = null;
    }

    // ---- Step 2: decision at this bar's CLOSE (completed bars [0..i]). ----
    const decisionTsMs = candle.timestampMs;
    const ctx = buildStrategyContext(symbol, candles, i, timeframe, portfolio, strategy);
    const signal = strategy.evaluate(ctx);
    if (signal.type !== 'HOLD') {
      const riskCtx = buildRiskContext(symbol, quote, signal, decisionTsMs, candle.close, portfolio, marketInfo);
      const decision = riskManager.evaluate(riskCtx);
      if (decision.approved) {
        // Approved quantity is IMMUTABLE pending intent — never re-sized at the next open.
        pending = {
          side: decision.side,
          quantity: decision.quantity,
          signalBarIndex: i,
          decisionTsMs,
        };
      } else {
        rejections.push({
          barIndex: i,
          side: decision.side ?? null,
          reason: decision.reason,
          timestampMs: decisionTsMs,
          phase: 'decision',
        });
      }
    }

    // ---- Step 3: mark equity at the bar CLOSE. ----
    const prices = new Map<string, Money>([[symbol, candle.close]]);
    const mtm = portfolio.markToMarket(prices);
    if (mtm.equity.compareTo(peak.value) > 0) peak.value = mtm.equity;
    const exposure = portfolio.exposure(prices);
    if (exposure.compareTo(maxExposure) > 0) maxExposure = exposure;
    equityCurve.push({ timestampMs: decisionTsMs, equity: mtm.equity });
  }

  const finalPrices = new Map<string, Money>([[symbol, candles[candles.length - 1]!.close]]);
  const finalMtm = portfolio.markToMarket(finalPrices);
  const finalQuoteCash = portfolio.cash(quote);
  const finalPositionQty = portfolio.position(symbol)?.quantity ?? Money.zero();

  const metrics = computeMetrics({
    barCount: candles.length,
    startingCapital: config.initialCash,
    endingCapital: finalMtm.equity,
    trades,
    equityCurve,
    peakEquity: peak.value,
    maxExposure,
  });

  if (sawGap) {
    warnings.push(
      'the candle series contains non-contiguous bars (gaps); fills use the next present bar\'s open and no prices are synthesized',
    );
  }

  return {
    config,
    symbol,
    timeframe,
    dataStartMs: candles[0]!.timestampMs,
    dataEndMs: candles[candles.length - 1]!.timestampMs,
    marketConstraints: mc,
    feeModel,
    slippageFraction: slippage,
    trades,
    rejections,
    equityCurve,
    metrics,
    finalQuoteCash,
    finalPositionQty,
    warnings,
    simulationLabel: 'HISTORICAL SIMULATION — NOT A PREDICTION OF FUTURE PERFORMANCE',
  };
}

interface ExecParams {
  symbol: string;
  quote: string;
  mc: BacktestConfig['marketConstraints'];
  slippage: number;
  feeModel: BacktestConfig['feeModel'];
  signalBarIndex: number;
  decisionTsMs: number;
  fillBarIndex: number;
  fillTimeMs: number;
  seq: number;
}

interface ExecOutcome {
  trade: BacktestTrade | null;
  rejection: BacktestRejection | null;
  portfolio: Portfolio | null;
  seq: number;
}

function executePending(portfolio: Portfolio, fillBar: import('../types.js').Candle, p: PendingIntent, params: ExecParams): ExecOutcome {
  const openPrice = fillBar.open;

  // Deterministic fill price at the next bar's OPEN.
  const fillPrice = computeFillPrice(openPrice, p.side, params.slippage, params.mc.priceTick);

  // Solve the exact cost/fee at the ACTUAL fill price.
  const notional = p.quantity.mul(fillPrice);
  const fee = computeQuoteFee(notional, params.feeModel);

  // --- Execution-time safety checks (never re-size, never re-approve). ---
  let rejectReason: string | null = null;
  if (!fillPrice.isPositive()) {
    rejectReason = 'INVALID_FILL_PRICE';
  } else if (!p.quantity.isPositive()) {
    rejectReason = 'INVALID_QUANTITY';
  } else if (!p.quantity.isMultipleOf(params.mc.quantityTick)) {
    rejectReason = 'PRECISION_VIOLATION';
  } else if (params.mc.minOrderBase !== null && p.quantity.compareTo(params.mc.minOrderBase) < 0) {
    rejectReason = 'BELOW_MIN_QUANTITY';
  } else if (p.side === 'BUY' && notional.add(fee).compareTo(portfolio.deployableQuote(params.quote)) > 0) {
    // A1: never spend more than the deployable quote at the ACTUAL fill price.
    rejectReason = 'INSUFFICIENT_BALANCE_AFTER_SLIPPAGE';
  } else if (p.side === 'SELL') {
    const held = portfolio.position(params.symbol)?.quantity ?? Money.zero();
    if (p.quantity.compareTo(held) > 0) {
      rejectReason = 'SELL_EXCEEDS_POSITION';
    }
  }

  if (rejectReason !== null) {
    return {
      trade: null,
      rejection: {
        barIndex: params.fillBarIndex,
        side: p.side,
        reason: rejectReason,
        timestampMs: params.fillTimeMs,
        phase: 'execution',
      },
      portfolio: null,
      seq: params.seq,
    };
  }

  // Realized P&L (SELL only) captured BEFORE applying, from the held position.
  let realizedPnl: Money | null = null;
  if (p.side === 'SELL') {
    const pos = portfolio.position(params.symbol);
    if (pos) {
      realizedPnl = p.quantity.mul(fillPrice.sub(pos.averageEntryPrice)).sub(fee);
    }
  }

  let next: Portfolio;
  try {
    next = portfolio.applyFill(params.symbol, p.side, p.quantity, fillPrice, fee);
  } catch (err) {
    // Any accounting-invariant failure (e.g. an oversell) is a deterministic
    // execution rejection and MUST leave the portfolio unchanged.
    return {
      trade: null,
      rejection: {
        barIndex: params.fillBarIndex,
        side: p.side,
        reason: `ACCOUNTING_REJECTED: ${err instanceof Error ? err.message : String(err)}`,
        timestampMs: params.fillTimeMs,
        phase: 'execution',
      },
      portfolio: null,
      seq: params.seq,
    };
  }

  const id = `bt-${params.symbol}-${params.signalBarIndex}-${params.seq}-${p.side}`;
  const trade: BacktestTrade = {
    id,
    barIndex: params.fillBarIndex,
    signalBarIndex: params.signalBarIndex,
    side: p.side,
    quantity: p.quantity,
    price: fillPrice,
    notional,
    fee,
    feeCurrency: 'quote',
    timestampMs: params.fillTimeMs,
    realizedPnl,
  };
  return { trade, rejection: null, portfolio: next, seq: params.seq + 1 };
}

function buildStrategyContext(
  symbol: string,
  candles: BacktestRunInput['candles'],
  i: number,
  timeframe: Timeframe,
  portfolio: Portfolio,
  strategy: Strategy,
): StrategyContext {
  const candle = candles[i]!;
  const position = portfolio.position(symbol);
  const series = candles.slice(0, i + 1); // completed bars [0..i], never beyond
  const posView: PositionView = {
    symbol,
    quantity: position?.quantity ?? Money.zero(),
    averageEntryPrice: position?.averageEntryPrice ?? null,
    realizedPnl: position?.realizedPnl ?? Money.zero(),
  };
  return {
    nowMs: candle.timestampMs,
    symbol,
    ticker: {
      symbol,
      bid: candle.close,
      ask: candle.close,
      last: candle.close,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      baseVolume: candle.baseVolume,
      quoteVolume: candle.quoteVolume ?? null,
      timestampMs: candle.timestampMs,
    },
    candles: series,
    timeframe,
    position: posView,
    insufficientData: series.length < strategy.warmupCandles,
  };
}

function buildRiskContext(
  symbol: string,
  quote: string,
  signal: import('../order.js').Signal,
  nowMs: number,
  price: Money,
  portfolio: Portfolio,
  marketInfo: MarketInfo,
): RiskContext {
  const prices = new Map<string, Money>([[symbol, price]]);
  const mtm = portfolio.markToMarket(prices);
  const position = portfolio.position(symbol);
  return {
    symbol,
    signal,
    nowMs,
    marketDataTimestampMs: nowMs,
    marketDataObservedAtMs: nowMs,
    price,
    marketInfo,
    quoteBalance: {
      currency: quote,
      total: portfolio.cash(quote),
      available: portfolio.deployableQuote(quote),
      held: portfolio.reserved(quote),
    },
    deployableQuote: portfolio.deployableQuote(quote),
    portfolioValue: mtm.equity,
    peakPortfolioValue: portfolio.stateModel.peakEquity,
    portfolioExposure: portfolio.exposure(prices),
    currentPosition: position?.quantity ?? Money.zero(),
    externalPosition: portfolio.external(symbol),
    openManagedPositionCount: portfolio.managedOpenCount(),
    realizedPnlToday: portfolio.stateModel.realizedPnl,
    unrealizedPnlToday: mtm.unrealizedPnl,
  };
}

/**
 * Build the smallest valid `MarketInfo` the existing RiskManager needs, from the
 * explicit `BacktestMarketConstraints` plus the declared quote fee model. The
 * fee presented to risk MATCHES the simulator's fee model so the risk funding
 * estimate agrees with the fill's A1 re-check. No NDAX-specific assumption here.
 */
export function buildMarketInfo(symbol: string, mc: BacktestConfig['marketConstraints'], feeRate: number): MarketInfo {
  return {
    symbol,
    exchangeId: 'backtest',
    priceTick: mc.priceTick,
    basePrecision: 8,
    quotePrecision: 8,
    quantityTick: mc.quantityTick,
    minOrderBase: mc.minOrderBase,
    minOrderQuote: null,
    supportsMarketOrders: true,
    feeInfo: { maker: feeRate, taker: feeRate, feeCurrency: 'quote' },
  };
}
