/**
 * `bot live-adopt-external-cash` — deliberately adopt pre-existing EXTERNAL
 * exchange quote cash as BOT-managed (deployable) capital.
 *
 * This is an OWNERSHIP / CAPITAL ASSIGNMENT decision, NOT trading.
 *
 * SAFETY CONTRACT:
 *   - It ONLY mutates the local LIVE managed portfolio. It NEVER sends
 *     SendOrder/CancelOrder and NEVER modifies an exchange balance.
 *   - LIVE realm only: it refuses to operate against PAPER state.
 *   - It reuses the existing managed-cash model (`Portfolio.adoptExternalCash`).
 *     It does not touch positions, reservations, executions, or P&L.
 *   - It REQUIRES an authenticated read of the exchange quote balance and an
 *     explicit interactive operator attestation (typing `ADOPT`). There is NO
 *     `--yes` / `--force` / unattended / environment-variable bypass.
 *   - FULL-RESIDUAL semantics: it adopts exactly `exchange available - managed
 *     cash` and never more than the verified exchange balance.
 *   - TOCTOU protection: after confirmation it re-reads the quote balance and
 *     fails closed if the residual changed materially.
 *   - Idempotency: once adopted the residual is zero, so a re-run refuses.
 *
 * This command is the sanctioned way to account pre-existing external quote
 * cash the operator has decided the bot may manage. It NEVER places the BUY; the
 * separate `bot live-test buy` remains the order step.
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

/** Dependencies for the testable adoption core (adapter may be read-only). */
export interface LiveAdoptExternalCashDeps {
  cfg: BotConfig;
  adapter: ExchangeAdapter;
  getPortfolio: () => Portfolio;
  savePortfolio: (p: Portfolio) => void;
  confirm?: (message: string) => Promise<boolean>;
  nowMs?: () => number;
  logger?: Logger;
}

/** No arguments are accepted: there is no amount, no --yes, no --force. */
export function parseLiveAdoptExternalCashArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  if (args.length === 0) return { ok: true };
  return {
    ok: false,
    error: `unexpected argument "${args[0]}". Usage: bot live-adopt-external-cash`,
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

/** Interactive TTY attestation requiring the explicit phrase `ADOPT`. */
async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    err('stdin is not a TTY; cannot confirm interactively. Refusing to continue.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toUpperCase() === 'ADOPT';
}

/** Read the exchange's authoritative available balance for a currency. */
async function readExchangeAvailable(
  adapter: ExchangeAdapter,
  currency: string,
): Promise<{ available: Money; balances: Balance[] }> {
  const balances = await adapter.getBalances();
  const bal = balances.find((b) => b.currency === currency) ?? null;
  return { available: bal ? bal.available : Money.zero(), balances };
}

/** The currently-EXTERNAL (non-managed) quote cash on the exchange. */
function externalCash(exchangeAvailable: Money, managed: Money): Money {
  if (exchangeAvailable.compareTo(managed) <= 0) return Money.zero();
  return exchangeAvailable.sub(managed);
}

/**
 * Run the adoption flow. Returns a process exit code:
 *   0 = external quote cash adopted and persisted;
 *   1 = refused (config/recovery/read failure, nothing to adopt, not confirmed,
 *       TOCTOU mismatch).
 */
export async function executeLiveAdoptExternalCash(deps: LiveAdoptExternalCashDeps): Promise<number> {
  const cfg = deps.cfg;
  const adapter = deps.adapter;
  const now = deps.nowMs ?? Date.now;

  // --- LIVE realm only. ---
  if (cfg.tradingMode !== 'live') {
    err('live-adopt-external-cash refuses: TRADING_MODE must be "live" (live realm only); it never touches PAPER state.');
    return 1;
  }
  // --- Authenticated exchange reads required. ---
  if (!cfg.enableAuthenticatedReads) {
    err('live-adopt-external-cash refuses: authenticated account reads are disabled (ENABLE_AUTHENTICATED_READS=true is required to verify the exchange balance).');
    return 1;
  }
  // --- Kill switch behavior preserved. ---
  if (cfg.killSwitch) {
    err('live-adopt-external-cash refuses: kill switch is active; capital should not be re-assigned now.');
    return 1;
  }
  // --- Narrow scope: exactly one configured trading pair. ---
  if (cfg.tradingPairs.length !== 1) {
    err('live-adopt-external-cash supports exactly one configured trading pair; refusing.');
    return 1;
  }

  const symbol = cfg.tradingPairs[0]!;
  const quote = symbol.split('/')[1];
  if (!quote) {
    err(`live-adopt-external-cash refuses: malformed symbol "${symbol}" (expected BASE/QUOTE).`);
    return 1;
  }

  const portfolio = deps.getPortfolio();
  const managed = portfolio.cash(quote);

  // --- Authenticated read-only exchange verification (first read). ---
  let exchangeAvailable: Money;
  try {
    ({ available: exchangeAvailable } = await readExchangeAvailable(adapter, quote));
  } catch (e) {
    err('live-adopt-external-cash refuses: could not read the exchange balance (authenticated read required): ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const external = externalCash(exchangeAvailable, managed);
  if (external.isNegative() || external.isZero()) {
    err(
      `live-adopt-external-cash refuses: no external ${quote} cash to adopt ` +
        `(exchange available=${exchangeAvailable.toString()}, managed=${managed.toString()}).`,
    );
    return 1;
  }

  // --- Display + explicit operator attestation. ---
  out('LIVE EXTERNAL QUOTE CASH ADOPTION (capital assignment, NOT trading)');
  out('  Symbol:                        ' + symbol);
  out('  Quote currency:                ' + quote);
  out('  Exchange-observed available:   ' + exchangeAvailable.toString() + ' ' + quote);
  out('  Currently bot-managed cash:    ' + managed.toString() + ' ' + quote);
  out('  Amount being adopted:          ' + external.toString() + ' ' + quote);
  out('  Resulting managed cash:        ' + managed.add(external).toString() + ' ' + quote);
  out('  Resulting classification:      BOT-managed (DEPLOYABLE)');
  out('  Exchange reads:                authenticated read-only; NO exchange mutation is performed');
  out('  WARNING: this does NOT place or cancel any order.');
  out('  WARNING: this makes ' + external.toString() + ' ' + quote + ' DEPLOYABLE by the bot (real funds at risk).');

  const prompt =
    '\nThis will reclassify ' + external.toString() + ' ' + quote +
    ' from external to bot-managed deployable capital.\n' +
    'Type ADOPT and press Enter to confirm, or anything else to abort.\n> ';
  const confirmed = deps.confirm ? await deps.confirm(prompt) : await defaultConfirm(prompt);
  if (!confirmed) {
    err('live-adopt-external-cash aborted: not confirmed. No local state was changed.');
    return 1;
  }

  // --- TOCTOU: fresh authenticated read immediately before adoption. ---
  let freshAvailable: Money;
  try {
    ({ available: freshAvailable } = await readExchangeAvailable(adapter, quote));
  } catch (e) {
    err('live-adopt-external-cash refused at the TOCTOU re-read: could not re-read the exchange balance: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const freshExternal = externalCash(freshAvailable, managed);
  if (!freshExternal.equals(external)) {
    err(
      'live-adopt-external-cash refused: the external balance changed since confirmation ' +
        `(confirmed ${external.toString()}, now ${freshExternal.toString()}); ` +
        'no adoption was applied. Re-run to re-read the current balance.',
    );
    return 1;
  }

  // --- Apply the ownership change using the existing managed-cash model. ---
  let next: Portfolio;
  try {
    next = portfolio.adoptExternalCash(quote, external);
  } catch (e) {
    err('live-adopt-external-cash internal error: ' + (e instanceof Error ? e.message : String(e)) + '; no state was persisted.');
    return 1;
  }

  if (!next.cash(quote).equals(managed.add(external))) {
    err('live-adopt-external-cash internal error: adopted cash did not produce the expected managed balance; no state was persisted.');
    return 1;
  }

  deps.savePortfolio(next);

  // --- Auditability (no credentials). ---
  deps.logger?.info(
    { event: 'live_external_cash_adopted', quoteCurrency: quote, amount: external.toString(), managedBefore: managed.toString(), managedAfter: next.cash(quote).toString(), atMs: now() },
    'operator adopted external quote cash as bot-managed deployable capital',
  );
  out('');
  out('LIVE EXTERNAL QUOTE CASH ADOPTION COMPLETE.');
  out('  ' + quote + ' now bot-managed: ' + next.cash(quote).toString() + ' (deployable).');
  out('  No order was placed. `bot live-test buy` remains the separate order step.');
  return 0;
}

export const liveAdoptExternalCashCommand: CommandHandler = async (args, ctx): Promise<number> => {
  const parsed = parseLiveAdoptExternalCashArgs(args);
  if (!parsed.ok) {
    err('live-adopt-external-cash: ' + parsed.error);
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
    err('live-adopt-external-cash needs authenticated account reads, but ENABLE_AUTHENTICATED_READS is not "true".');
    return 1;
  }

  try {
    assertLiveRealmRecoverable(cfg);
  } catch (e) {
    err('live-adopt-external-cash: ' + (e instanceof Error ? e.message : String(e)));
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

  return executeLiveAdoptExternalCash({
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
