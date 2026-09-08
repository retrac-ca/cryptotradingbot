/**
 * `bot live-onboard-external` — deliberately authorize existing EXTERNAL
 * exchange inventory as bot-managed inventory (for the controlled LIVE path).
 *
 * This is INVENTORY ONBOARDING / OWNERSHIP AUTHORIZATION, NOT trading.
 *
 * SAFETY CONTRACT:
 *   - It ONLY mutates the local LIVE managed portfolio. It NEVER sends
 *     SendOrder/CancelOrder and NEVER modifies an exchange balance.
 *   - LIVE realm only: it refuses to operate against PAPER state.
 *   - It reuses the existing `Portfolio.withExternalSnapshot` +
 *     `Portfolio.authorizeExternal` ownership model. It does NOT modify the
 *     underlying ownership/accounting invariants.
 *   - It REQUIRES an authenticated read of the exchange balance and an explicit
 *     interactive operator attestation (typing `AUTHORIZE`). There is NO
 *     `--yes` / `--force` / unattended / environment-variable bypass.
 *   - FULL-QUANTITY semantics: `authorizeExternal` authorizes the full declared
 *     external quantity. The command derives that quantity from the exchange
 *     balance (`exchange available - managed`) and never authorizes more than
 *     the verified exchange balance. Partial authorization is NOT implemented.
 *   - TOCTOU protection: after confirmation it re-reads the exchange balance and
 *     fails closed if the external quantity changed materially (it never
 *     silently adjusts the amount after confirmation).
 *   - Idempotency: if the symbol is already authorized, or there is no external
 *     inventory left to authorize, it fails safely with a clear message.
 *
 * After onboarding, the separate `bot live-test` command remains responsible for
 * the actual controlled SELL. This command NEVER places the SELL.
 */

import { createInterface } from 'node:readline';
import type { Logger } from '../logging/logger.js';
import { Money } from '../money/Money.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { createExchange } from '../exchanges/index.js';
import { loadConfig } from '../config/load.js';
import type { BotConfig } from '../config/schema.js';
import type { Balance } from '../types.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { ManagedStateStore } from '../persistence/index.js';
import { toReadOnlyAdapter } from './manual-cmd.js';
import { loadLiveManagedPortfolio, assertLiveRealmRecoverable } from './live-test-cmd.js';
import type { CommandHandler } from './context.js';

/** Dependencies for the testable onboarding core (adapter may be read-only). */
export interface LiveOnboardExternalDeps {
  cfg: BotConfig;
  adapter: ExchangeAdapter;
  getPortfolio: () => Portfolio;
  savePortfolio: (p: Portfolio) => void;
  confirm?: (message: string) => Promise<boolean>;
  nowMs?: () => number;
  logger?: Logger;
}

/** No arguments are accepted: there is no quantity, no --yes, no --force. */
export function parseLiveOnboardExternalArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  if (args.length === 0) return { ok: true };
  return {
    ok: false,
    error: `unexpected argument "${args[0]}". Usage: bot live-onboard-external`,
  };
}

function err(s: string): void {
  // eslint-disable-next-line no-console
  console.error(s);
}

function out(s: string): void {
  // eslint-disable-next-line no-console
  console.log(s);
}

/** Interactive TTY attestation requiring the explicit phrase `AUTHORIZE`. */
async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    err('stdin is not a TTY; cannot confirm interactively. Refusing to continue.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toUpperCase() === 'AUTHORIZE';
}

/** Read the exchange's authoritative available base balance for `base`. */
async function readExchangeBase(adapter: ExchangeAdapter, base: string): Promise<{ exchangeBase: Money; balances: Balance[] }> {
  const balances = await adapter.getBalances();
  const bal = balances.find((b) => b.currency === base) ?? null;
  const exchangeBase = bal ? bal.available : Money.zero();
  return { exchangeBase, balances };
}

/** The currently-EXTERNAL (non-managed) quantity for the symbol on the exchange. */
function externalQuantity(exchangeBase: Money, managed: Money): Money {
  if (exchangeBase.compareTo(managed) <= 0) return Money.zero();
  return exchangeBase.sub(managed);
}

/**
 * Run the onboarding flow. Returns a process exit code:
 *   0 = inventory authorized and persisted;
 *   1 = refused (config/recovery/read failure, nothing to authorize, not confirmed,
 *       TOCTOU mismatch).
 */
export async function executeLiveOnboardExternal(deps: LiveOnboardExternalDeps): Promise<number> {
  const cfg = deps.cfg;
  const adapter = deps.adapter;
  const now = deps.nowMs ?? Date.now;

  // --- LIVE realm only. ---
  if (cfg.tradingMode !== 'live') {
    err('live-onboard-external refuses: TRADING_MODE must be "live" (live realm only); it never touches PAPER state.');
    return 1;
  }
  // --- Authenticated exchange reads required. ---
  if (!cfg.enableAuthenticatedReads) {
    err('live-onboard-external refuses: authenticated account reads are disabled (ENABLE_AUTHENTICATED_READS=true is required to verify the exchange balance).');
    return 1;
  }
  // --- Kill switch behavior preserved. ---
  if (cfg.killSwitch) {
    err('live-onboard-external refuses: kill switch is active; live trading is stopped and inventory should not be re-baselined now.');
    return 1;
  }
  // --- Narrow scope: exactly one configured trading pair. ---
  if (cfg.tradingPairs.length !== 1) {
    err('live-onboard-external supports exactly one configured trading pair; refusing.');
    return 1;
  }

  const symbol = cfg.tradingPairs[0]!;
  const base = symbol.split('/')[0];
  if (!base) {
    err(`live-onboard-external refuses: malformed symbol "${symbol}" (expected BASE/QUOTE).`);
    return 1;
  }

  const portfolio = deps.getPortfolio();

  // --- Already authorized? (idempotency; never duplicate inventory). ---
  if (portfolio.isAuthorizedExternal(symbol)) {
    err(`live-onboard-external refuses: ${symbol} is already authorized for bot management; nothing further to authorize.`);
    return 1;
  }

  const managed = portfolio.position(symbol)?.quantity ?? Money.zero();

  // --- Authenticated read-only exchange verification (first read). ---
  let exchangeBase: Money;
  try {
    ({ exchangeBase } = await readExchangeBase(adapter, base));
  } catch (e) {
    err('live-onboard-external refuses: could not read the exchange balance (authenticated read required): ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const external = externalQuantity(exchangeBase, managed);
  if (external.isNegative() || external.isZero()) {
    err(`live-onboard-external refuses: no external ${base} inventory to authorize (exchange available=${exchangeBase.toString()}, managed=${managed.toString()}).`);
    return 1;
  }

  // --- Display + explicit operator attestation. ---
  out('LIVE EXTERNAL INVENTORY ONBOARDING (ownership authorization, NOT trading)');
  out('  Symbol:                   ' + symbol);
  out('  Exchange-observed available: ' + exchangeBase.toString() + ' ' + base);
  out('  Quantity being authorized:   ' + external.toString() + ' ' + base);
  out('  Resulting classification:    EXTERNAL_AUTHORIZED');
  out('  Cost basis:                  zero (pre-existing inventory; no bot acquisition cost)');
  out('  Exchange reads:              authenticated read-only; NO exchange mutation is performed');
  out('  WARNING: this does NOT place or cancel any order.');
  out('  WARNING: this changes the bot\'s LOCAL ownership/accounting baseline for ' + symbol + '.');

  const prompt =
    '\nThis will authorize ' + external.toString() + ' ' + base +
    ' as bot-managed (EXTERNAL_AUTHORIZED) inventory.\n' +
    'Type AUTHORIZE and press Enter to confirm, or anything else to abort.\n> ';
  const confirmed = deps.confirm ? await deps.confirm(prompt) : await defaultConfirm(prompt);
  if (!confirmed) {
    err('live-onboard-external aborted: not confirmed. No local state was changed.');
    return 1;
  }

  // --- TOCTOU: fresh authenticated read immediately before authorization. ---
  let freshExchangeBase: Money;
  try {
    ({ exchangeBase: freshExchangeBase } = await readExchangeBase(adapter, base));
  } catch (e) {
    err('live-onboard-external refused at the TOCTOU re-read: could not re-read the exchange balance: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const freshExternal = externalQuantity(freshExchangeBase, managed);
  if (!freshExternal.equals(external)) {
    err(
      'live-onboard-external refused: the external balance changed since confirmation ' +
        `(confirmed ${external.toString()}, now ${freshExternal.toString()}); ` +
        'no authorization was applied. Re-run to re-read the current balance.',
    );
    return 1;
  }

  // --- Build the authorized portfolio using the EXISTING ownership model. ---
  // Declare the exact observed external quantity, then authorize the full amount.
  let next = portfolio.withExternalSnapshot(new Map([[symbol, external]]));
  next = next.authorizeExternal(symbol);

  const pos = next.position(symbol);
  // The authorization must have produced a position whose EXTERNAL_AUTHORIZED
  // provenance equals the authorized quantity. (If a pre-existing BOT position
  // exists, `authorizeExternal` merges and preserves provenance via
  // `sourceQuantities`; `source` may then be BOT, which is correct.)
  if (!pos || !pos.sourceQuantities.EXTERNAL_AUTHORIZED.equals(external)) {
    err('live-onboard-external internal error: authorization did not produce the expected EXTERNAL_AUTHORIZED quantity; no state was persisted.');
    return 1;
  }

  deps.savePortfolio(next);

  // --- Auditability (no credentials). ---
  deps.logger?.info(
    { event: 'live_external_inventory_authorized', symbol, quantity: external.toString(), source: 'EXTERNAL_AUTHORIZED', costBasis: 'zero', atMs: now() },
    'operator authorized external inventory as bot-managed',
  );
  out('');
  out('LIVE EXTERNAL INVENTORY ONBOARDING COMPLETE.');
  out('  ' + base + ' now bot-managed: ' + pos.quantity.toString() + ' (' + pos.source + ', zero cost basis).');
  out('  No order was placed. The controlled `bot live-test sell` remains the separate order step.');
  return 0;
}

export const liveOnboardExternalCommand: CommandHandler = async (args, ctx): Promise<number> => {
  const parsed = parseLiveOnboardExternalArgs(args);
  if (!parsed.ok) {
    err('live-onboard-external: ' + parsed.error);
    return 1;
  }

  let cfg: BotConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    err('Configuration error:\n' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  if (!cfg.enableAuthenticatedReads) {
    err('live-onboard-external needs authenticated account reads, but ENABLE_AUTHENTICATED_READS is not "true".');
    return 1;
  }

  try {
    assertLiveRealmRecoverable(cfg);
  } catch (e) {
    err('live-onboard-external: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);

  let adapter: ExchangeAdapter;
  try {
    adapter = createExchange(cfg.exchange, {
      credentials,
      config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl },
    });
  } catch (e) {
    err('Could not construct the exchange adapter:\n' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  // Runtime structural guard: no code path here can reach an exchange write method.
  const readOnly = toReadOnlyAdapter(adapter);

  const liveStore = new ManagedStateStore(cfg.liveManagedStateFile);
  let managed: Portfolio;
  try {
    managed = loadLiveManagedPortfolio(cfg);
  } catch (e) {
    err('Live managed state is not safe to operate on: ' + (e instanceof Error ? e.message : String(e)) + '\nRefusing to proceed.');
    return 1;
  }

  return executeLiveOnboardExternal({
    cfg,
    adapter: readOnly,
    getPortfolio: () => managed,
    savePortfolio: (p) => {
      managed = p;
      liveStore.save(p.stateModel);
    },
    logger: ctx.logger,
  });
};
