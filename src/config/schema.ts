/**
 * Configuration schema and types.
 *
 * All user-facing configuration is validated here at startup. Values come from
 * environment variables (via a `.env` file) and are coerced into a single typed
 * `BotConfig` object.
 *
 * SECURITY: this schema deliberately does NOT retain raw secrets beyond the
 * two credential fields (which are used to construct adapters, never logged).
 * Everything else is non-secret.
 */

import { z } from 'zod';
import type { Timeframe } from '../types.js';

const SYMBOL_RE = /^[A-Za-z0-9]{2,12}\/[A-Za-z0-9]{2,12}$/;

const boolFromString = z.preprocess((v) => {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return v;
}, z.boolean());

const fractionZeroToOne = z.coerce
  .number()
  .min(0)
  .max(1)
  .describe('fraction in [0,1]');

const timeframeSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);

export const botConfigSchema = z.object({
  // --- Trading mode ---
  tradingMode: z.enum(['paper', 'live']).default('paper'),
  // Explicitly marks real funds at risk for live trading.
  realFundsAtRisk: boolFromString.default(false),

  // --- Exchange ---
  exchange: z.enum(['ndax']).default('ndax'),
  ndaxApiKey: z.string().default(''),
  ndaxApiSecret: z.string().default(''),
  // Retail NDAX auth model also requires the numeric UserId (see docs/NDAX_API.md).
  ndaxUserId: z.string().default(''),
  // Account email/login — needed by GetUserAccounts to resolve the account id
  // (CCXT uses the login email there). Optional; provide an explicit
  // NDAX_ACCOUNT_ID instead if preferred.
  ndaxUserName: z.string().default(''),
  // An explicit NDAX account id, skipping the GetUserAccounts lookup.
  ndaxAccountId: z.coerce.number().int().positive().optional(),
  // Gate for authenticated reads (defaults OFF for safety).
  enableAuthenticatedReads: boolFromString.default(false),
  ndaxRestBaseUrl: z.string().url().optional(),
  ndaxWsUrl: z.string().url().optional(),

  // --- Trading pairs ---
  tradingPairs: z
    .string()
    .default('BTC/CAD')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
    )
    .pipe(
      z.array(z.string().regex(SYMBOL_RE, 'must be BASE/QUOTE, e.g. BTC/CAD')).min(1),
    ),

  // --- Strategy ---
  strategy: z.string().default('moving-average-crossover'),
  timeframe: timeframeSchema.default('5m'),
  maFastPeriod: z.coerce.number().int().positive().default(10),
  maSlowPeriod: z.coerce.number().int().positive().default(30),

  // --- Risk (conservative defaults) ---
  maxPositionSizeFraction: fractionZeroToOne.default(0.1),
  maxTradeAmount: z.coerce.number().min(0).default(0),
  stopLossFraction: fractionZeroToOne.default(0.05),
  takeProfitFraction: fractionZeroToOne.default(0.1),
  maxDailyLossFraction: fractionZeroToOne.default(0.05),
  maxOpenPositions: z.coerce.number().int().min(0).default(1),
  cooldownAfterLossSeconds: z.coerce.number().int().min(0).default(3600),
  paperStartingBalance: z.coerce.number().positive().default(10000),

  // --- System ---
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  reconcileIntervalSeconds: z.coerce.number().int().min(1).default(60),
  killSwitch: boolFromString.default(false),
});

export type BotConfig = z.infer<typeof botConfigSchema>;

/** Cross-field validation that zod's per-field checks cannot express. */
export function validateConfig(cfg: BotConfig): void {
  if (cfg.maSlowPeriod <= cfg.maFastPeriod) {
    throw new Error(
      `Invalid strategy parameters: MA_SLOW_PERIOD (${cfg.maSlowPeriod}) must be greater than MA_FAST_PERIOD (${cfg.maFastPeriod}).`,
    );
  }

  if (cfg.maxPositionSizeFraction === 0) {
    throw new Error(
      'Invalid risk config: MAX_POSITION_SIZE_FRACTION is 0, which disables all trading. Set a value in (0, 1] or confirm this is intended.',
    );
  }

  if (cfg.tradingMode === 'live' && !cfg.realFundsAtRisk) {
    throw new Error(
      'LIVE TRADING is enabled but REAL_FUNDS_AT_RISK is not set to "true". ' +
        'Live trading places real orders with real money. Set REAL_FUNDS_AT_RISK=true ' +
        'to confirm you understand the risks, or use TRADING_MODE=paper.',
    );
  }
}

/** Validate the configured timeframe is one we support (compile-time safety helper). */
export function isKnownTimeframe(tf: string): tf is Timeframe {
  return (['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as string[]).includes(tf);
}
