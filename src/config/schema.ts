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
import { resolve as pathResolve, sep as pathSep } from 'node:path';
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

  // --- Curated multi-asset universe ---
  // The bot's approved UNIVERSE. The bot only ever evaluates markets in this
  // approval whitelist (it never auto-trades every market an exchange lists).
  // Each is further filtered through eligibility (quote currency, valid ticks,
  // min order, fees, market orders) at runtime. Comma-separated canonical
  // symbols. This is the effective symbol set the coordinator/polling use; if
  // unset it falls back to `tradingPairs`.
  universeMarkets: z
    .string()
    .default('BTC/CAD,ETH/CAD,SOL/CAD,XRP/CAD,ADA/CAD')
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
  // NOTE: stopLossFraction / takeProfitFraction are parsed for configurability
  // but are NOT yet enforced by the engine (see docs/DECISIONS.md Gate 5). They
  // are surfaced only to make it explicit they are inactive, so we never imply a
  // protection that does not exist.
  stopLossFraction: fractionZeroToOne.default(0.05),
  takeProfitFraction: fractionZeroToOne.default(0.1),
  maxDailyLossFraction: fractionZeroToOne.default(0.05),
  maxOpenPositions: z.coerce.number().int().min(0).default(1),
  cooldownAfterLossSeconds: z.coerce.number().int().min(0).default(3600),
  // Phase 7 additions:
  maxPortfolioExposureFraction: fractionZeroToOne.default(0.5),
  maxDrawdownFraction: fractionZeroToOne.default(0.1),
  marketDataMaxAgeMs: z.coerce.number().int().positive().default(60000),
  // Gate 4 (hybrid freshness): separate TRANSPORT (fetch) age limit and a
  // bounded clock-skew guard for forward-dated exchange quote timestamps.
  marketDataTransportMaxAgeMs: z.coerce.number().int().positive().default(60000),
  maxClockSkewMs: z.coerce.number().int().min(0).default(120000),
  paperStartingBalance: z.coerce.number().positive().default(10000),

  // --- Paper execution / engine (Phase 8) ---
  // Paper fill/fee/slippage realism knobs. 0 disables the respective effect.
  paperFeeFraction: fractionZeroToOne.default(0.0005),
  paperSlippageFraction: z.coerce.number().min(0).default(0.0005),
  paperFillFraction: fractionZeroToOne.default(1),
  // The single state directory under which ALL durable state lives (paper, live
  // managed, order ledger, manual intents, the mutation lock, and the init
  // marker). All state domains must resolve under it (validated below).
  stateDir: z.string().default('.state/'),
  // Where the persisted paper state (portfolio, executed orders) is kept so a
  // restart does not reset the account.
  paperStateFile: z.string().default('.state/paper-state.json'),
  // Where the persisted LIVE managed state is kept. This is the bot's authorized
  // inventory on the REAL exchange. It MUST be a DIFFERENT file from
  // `paperStateFile` (validated below): paper-managed positions must never be
  // able to masquerade as live-managed positions, and vice versa.
  liveManagedStateFile: z.string().default('.state/live-managed-state.json'),
  // Where the durable order ledger (every order the bot attempts, keyed by
  // clientOrderId) is kept for duplicate-order prevention and reconciliation.
  orderLedgerFile: z.string().default('.state/order-ledger.json'),
  // Where the manual-execution intents are kept (Gate 9). These are RETRAC's
  // RECOMMENDATIONS for an operator to execute externally — deliberately SEPARATE
  // from `orderLedgerFile` (RETRAC-submitted orders) so a manual execution can
  // never be confused with a submitted live order, and separate from the managed
  // portfolio state file (which holds accounting, not intent).
  manualIntentFile: z.string().default('.state/manual-intents.json'),
  // How often the engine re-evaluates candles/signals (ms); also the market-data
  // candle poll cadence. Kept small in tests via override.
  evaluateIntervalSeconds: z.coerce.number().int().positive().default(60),

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

  // F-1 safety: paper and live managed state must be physically separate. If a
  // single path were used, paper positions could be (mis)interpreted as the bot's
  // live-managed inventory — a fundamental ownership violation. Refuse to run.
  if (cfg.liveManagedStateFile === cfg.paperStateFile) {
    throw new Error(
      'Invalid config: LIVE_MANAGED_STATE_FILE and PAPER_STATE_FILE must be different paths. ' +
        'Paper managed state and live managed state are separate and must never share a file.',
    );
  }

  // Persistence: all four state domains must resolve under the single stateDir,
  // so the mutation lock and init marker are shared and no domain can be placed
  // in an unrelated directory. Only enforced when stateDir is present (the
  // schema always sets it for env-loaded configs; partial config objects that
  // omit it are treated as legacy/overrides).
  if (cfg.stateDir) {
    const dir = resolvePath(cfg.stateDir);
    for (const [name, p] of [
      ['PAPER_STATE_FILE', cfg.paperStateFile],
      ['LIVE_MANAGED_STATE_FILE', cfg.liveManagedStateFile],
      ['ORDER_LEDGER_FILE', cfg.orderLedgerFile],
      ['MANUAL_INTENT_FILE', cfg.manualIntentFile],
    ] as const) {
      if (p) {
        const resolved = resolvePath(p);
        if (resolved !== dir && !resolved.startsWith(dir + pathSep)) {
          throw new Error(
            `Invalid config: ${name} (${p}) must be under STATE_DIR (${cfg.stateDir}). ` +
              'All state domains must live in the same state directory.',
          );
        }
      }
    }
  }
}

/** Validate the configured timeframe is one we support (compile-time safety helper). */
export function isKnownTimeframe(tf: string): tf is Timeframe {
  return (['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as string[]).includes(tf);
}

function resolvePath(p: string): string {
  return pathResolve(p);
}
