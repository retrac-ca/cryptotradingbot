/**
 * Strategy module.
 *
 * Exposes the `Strategy` abstraction, `StrategyContext`, `Signal` helpers, the
 * strategy registry, and the built-in strategies. Importing the built-in
 * strategy modules (re-exported below) registers them with the registry, so
 * importing this module is enough to make createStrategy() work.
 */

import './movingAverageCrossover.js';

export type { Strategy } from './Strategy.js';
export type { StrategyContext, PositionView } from './StrategyContext.js';
export { signal, hold, signalToOrderSide } from './Signal.js';
export type { Signal, SignalType, SignalOptions } from './Signal.js';
export { sma, ema } from './indicators.js';
export { MovingAverageCrossoverStrategy } from './movingAverageCrossover.js';
export { buildStrategy } from './buildStrategy.js';
export {
  createStrategy,
  isStrategySupported,
  getSupportedStrategies,
  registerStrategy,
  resetStrategyRegistry,
} from './registry.js';
export type { StrategyRegistryParams, StrategyFactory } from './registry.js';
