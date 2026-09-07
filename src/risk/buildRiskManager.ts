/**
 * Build a RiskManager from the bot configuration.
 *
 * This is the single place where config -> risk happens, mirroring
 * `buildStrategy`, so the engine (Phase 8+) calls `buildRiskManager(cfg)` and
 * gets a ready RiskManager without knowing how its limits are derived.
 */

import { Money } from '../money/Money.js';
import type { BotConfig } from '../config/schema.js';
import type { RiskConfig } from './RiskConfig.js';
import { RiskManager } from './RiskManager.js';

export function buildRiskConfig(cfg: BotConfig): RiskConfig {
  return {
    maxTradeAmount: Money.fromNumber(cfg.maxTradeAmount),
    maxPositionSizeFraction: cfg.maxPositionSizeFraction,
    maxPortfolioExposureFraction: cfg.maxPortfolioExposureFraction,
    maxDailyLossFraction: cfg.maxDailyLossFraction,
    maxDrawdownFraction: cfg.maxDrawdownFraction,
    cooldownAfterLossMs: cfg.cooldownAfterLossSeconds * 1000,
    maxOpenPositions: cfg.maxOpenPositions ?? 1,
    marketDataMaxAgeMs: cfg.marketDataMaxAgeMs,
    // Conservative fallbacks so callers passing partial config (e.g. tests that
    // cast a partial BotConfig) still fail closed rather than blowing up.
    marketDataTransportMaxAgeMs: cfg.marketDataTransportMaxAgeMs ?? 60000,
    maxClockSkewMs: cfg.maxClockSkewMs ?? 120000,
  };
}

export function buildRiskManager(cfg: BotConfig): RiskManager {
  const risk = new RiskManager(buildRiskConfig(cfg));
  if (cfg.killSwitch) {
    risk.setKillSwitch(true);
  }
  return risk;
}
