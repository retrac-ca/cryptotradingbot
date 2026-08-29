/**
 * Build a Strategy from the bot configuration.
 *
 * This is the single place where config -> strategy happens, so the engine
 * (Phase 8+) just calls `buildStrategy(cfg)` and gets a ready strategy without
 * knowing the concrete type.
 */

import type { BotConfig } from '../config/schema.js';
import './movingAverageCrossover.js'; // side-effect: ensures built-in strategies are registered
import type { Strategy } from './Strategy.js';
import { createStrategy } from './registry.js';

/**
 * Build the configured strategy. `timeframeOverride` lets a caller run the
 * strategy on a timeframe other than the one baked into config (e.g. for
 * backtesting against a fixed series).
 */
export function buildStrategy(cfg: BotConfig, timeframeOverride?: BotConfig['timeframe']): Strategy {
  return createStrategy(cfg.strategy, {
    timeframe: timeframeOverride ?? cfg.timeframe,
    fastPeriod: cfg.maFastPeriod,
    slowPeriod: cfg.maSlowPeriod,
  });
}
