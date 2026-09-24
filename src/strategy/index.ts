/**
 * Strategy module.
 *
 * Exposes the `Strategy` abstraction, `StrategyContext`, `Signal` helpers, the
 * strategy registry, and the built-in strategies. Importing the built-in
 * strategy modules (re-exported below) registers them with the registry, so
 * importing this module is enough to make createStrategy() work.
 */

import './movingAverageCrossover.js';
import './donchianBreakout.js';
import './meanReversion.js';
import './trendPullbackRecovery.js';

export type { Strategy } from './Strategy.js';
export type { StrategyContext, PositionView } from './StrategyContext.js';
export { signal, hold, signalToOrderSide } from './Signal.js';
export type { Signal, SignalType, SignalOptions } from './Signal.js';
export { sma, ema } from './indicators.js';
export { MovingAverageCrossoverStrategy } from './movingAverageCrossover.js';
export { DonchianBreakoutStrategy, DEFAULT_DONCHIAN_LOOKBACK } from './donchianBreakout.js';
export type { DonchianBreakoutParams } from './donchianBreakout.js';
export {
  MeanReversionStrategy,
  DEFAULT_MEAN_REVERSION_PERIOD,
  DEFAULT_MEAN_REVERSION_DEVIATION,
} from './meanReversion.js';
export type { MeanReversionParams } from './meanReversion.js';
export {
  TrendPullbackRecoveryStrategy,
  DEFAULT_TPR_SMA_PERIOD,
  DEFAULT_TPR_SLOPE_LOOKBACK,
  DEFAULT_TPR_SWING_LOOKBACK,
  DEFAULT_TPR_MIN_PULLBACK_FRACTION,
  DEFAULT_TPR_PROFIT_TARGET_FRACTION,
} from './trendPullbackRecovery.js';
export type { TrendPullbackRecoveryParams } from './trendPullbackRecovery.js';
export { buildStrategy } from './buildStrategy.js';
export {
  createStrategy,
  isStrategySupported,
  getSupportedStrategies,
  registerStrategy,
  resetStrategyRegistry,
} from './registry.js';
export type { StrategyRegistryParams, StrategyFactory } from './registry.js';
