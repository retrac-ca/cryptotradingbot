/**
 * Strategy registry — maps a strategy name (from config) to a factory that
 * builds a `Strategy`. The engine asks the registry for the strategy at startup
 * using the configured parameters; it never constructs concrete strategies
 * directly.
 *
 * Mirror of the exchange registry, so adding a strategy is a one-line register
 * call — the engine and config plumbing stay unchanged.
 */

import type { Timeframe } from '../types.js';
import type { Strategy } from './Strategy.js';

/** Strategy parameters that apply across all strategies (from bot config). */
export interface StrategyRegistryParams {
  /** Candle timeframe the strategy runs on. */
  timeframe: Timeframe;
  /** Anything else the concrete strategy defines (fast/slow periods, etc.). */
  [key: string]: unknown;
}

export interface StrategyFactory {
  (params: StrategyRegistryParams): Strategy;
}

const factories = new Map<string, StrategyFactory>();

/** Register a strategy factory (called once at import time). */
export function registerStrategy(name: string, factory: StrategyFactory): void {
  factories.set(name, factory);
}

export function getSupportedStrategies(): string[] {
  return [...factories.keys()];
}

export function isStrategySupported(name: string): boolean {
  return factories.has(name);
}

/** Build a strategy for the named strategy with the given params. */
export function createStrategy(
  name: string,
  params: StrategyRegistryParams,
): Strategy {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `Strategy "${name}" is not available. Supported strategies: ${
        getSupportedStrategies().join(', ') || '(none registered yet)'
      }`,
    );
  }
  return factory(params);
}

export function resetStrategyRegistry(): void {
  factories.clear();
}
