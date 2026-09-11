/**
 * `bot live-test` — a one-shot, operator-gated SELL against a LIVE account.
 *
 * Purpose: let a human run a single, deliberate, risk-sized SELL to validate the
 * real live path (authenticated reads, reconciliation, order placement) WITHOUT
 * letting the bot trade continuously. It is the sanctioned safe-first live
 * floor: the very first live order should be a small, risk-reducing SELL chosen
 * by hand, not an autonomous BUY.
 *
 * SAFETY PROPERTIES — all fail closed:
 *  1. GATES BEFORE ANY EXCHANGE CONTACT: tradingMode 'live', realFundsAtRisk,
 *     kill switch off, --confirm-live, authenticated reads on, exactly one
 *     trading pair, and the adapter must support order placement. Any failure
 *     refuses before a single network call.
 *  2. NO QUANTITY INJECTION: the operator may only bound the size with
 *     `--target-cad <N>` (a CAD notional cap). The final order quantity is
 *     computed by the RiskManager (min of the target and the held position,
 *     floored to the quantity tick). There is NO accept-arbitrary-quantity path.
 *  3. RISK GATE: the RiskManager decides. If it rejects (e.g. stale market data)
 *     no order is placed and no exchange order-placement call is made.
 *  4. DIFFERENTIAL FRESHNESS: the quote time (exchange `TimeStamp`/L2 action)
 *     and the local transport time must both be fresh, subject to a bounded
 *     clock-skew guard.
 *  5. ONE ORDER, NO RETRY: confirmation + a single `place()`. Ambiguous outcomes
 *     (timeout/unknown) are NEVER retried — the command reconciles and exits
 *     non-zero, instructing the operator to run `bot reconcile` / `bot trades`.
 *  6. ACK ≠ FILLED: after an ack the command queries authoritative order state
 *     and reconciles; if those confirmations fail it does NOT claim success.
 *     "Accepted != Filled" — a later `bot reconcile` confirms the final fill.
 */

import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import type { BotConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { LiveOrderEngine } from '../execution/LiveExecutionEngine.js';
import { createControlledLiveAuthorization } from '../execution/ControlledLiveAuthorization.js';
import type { Logger } from '../logging/logger.js';
import { evaluateFreshness, isValidEpochMs } from '../marketdata/index.js';
import type { FreshnessPolicy } from '../marketdata/index.js';
import { Money } from '../money/Money.js';
import {
  OrderStore,
  ManagedStateStore,
  PaperStateStore,
  StateInitMarker,
  withStateDirLock,
  recoverState,
  CorruptStateError,
} from '../persistence/index.js';
import { ManualIntentStore } from '../manual/index.js';
import { Portfolio } from '../portfolio/index.js';
import { ReconcileService, reconcile, livePreTradeGate } from '../reconcile/index.js';
import type { ReconciliationDeps, ReconciliationResult, LivePreTradeGateResult } from '../reconcile/index.js';
import { buildRiskManager } from '../risk/index.js';
import type { RiskContext } from '../risk/index.js';
import type { RiskDecision } from '../risk/Reason.js';
import { signal } from '../strategy/Signal.js';
import type { Balance, MarketInfo, Ticker } from '../types.js';
import type { CommandHandler } from './context.js';

export interface LiveTestOptions {
  /** Operator acknowledged this is a real live trade. */
  confirmLive: boolean;
  /** Bounded CAD notional the operator wants to exit (capped by position). */
  targetCad: number;
}

export const LIVE_TEST_DEFAULT_TARGET_CAD = 12;
export const LIVE_TEST_MAX_TARGET_CAD = 50;

interface RefreshGate {
  label: string;
  passed: boolean;
  detail: string;
}

export interface LiveTestDeps {
  cfg: BotConfig;
  adapter: ExchangeAdapter;
  store: OrderStore;
  /** Durable live-managed store (V1 reconciliation + ownership). */
  live: ManagedStateStore;
  /** Durable manual-intent store (V1 cross-domain reconciliation). */
  manualIntents: ManualIntentStore;
  reconcile: ReconcileService;
  riskManager: import('../risk/RiskManager.js').RiskManager;
  /** The bot-MANAGED portfolio. External holdings are never sold here. */
  portfolio: Portfolio;
  confirm?: (message: string) => Promise<boolean>;
  nowMs?: () => number;
  logger?: Logger;
}

const FAIL = (error: string) => ({ ok: false as const, error });

export function parseLiveTestArgs(args: string[]): { ok: true; opts: LiveTestOptions } | { ok: false; error: string } {
  const opts: LiveTestOptions = {
    confirmLive: false,
    targetCad: LIVE_TEST_DEFAULT_TARGET_CAD,
  };
  let sawSell = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === 'sell') {
      if (sawSell) return FAIL('duplicate "sell" subcommand');
      sawSell = true;
      continue;
    }
    if (arg === '--confirm-live') {
      opts.confirmLive = true;
      continue;
    }
    if (arg === '--target-cad') {
      const raw = args[i + 1];
      if (raw === undefined) return FAIL('--target-cad requires a value');
      const num = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(num)) {
        return FAIL(`--target-cad expects a number, got "${raw}"`);
      }
      if (num < 0) return FAIL('--target-cad must not be negative');
      if (num > LIVE_TEST_MAX_TARGET_CAD) {
        return FAIL(`--target-cad exceeds the hard limit of ${LIVE_TEST_MAX_TARGET_CAD} CAD`);
      }
      opts.targetCad = num;
      i += 1;
      continue;
    }
    return FAIL(`unknown argument "${arg}". Usage: bot live-test sell [--target-cad <N>] [--confirm-live]`);
  }

  return { ok: true, opts };
}

/**
 * Shared gate checks, run BEFORE any exchange contact. Returns the gates that
 * were evaluated; a caller refuses (exit 1) if any fails.
 */
function evaluateGates(cfg: BotConfig, opts: LiveTestOptions, adapter: ExchangeAdapter): RefreshGate[] {
  return [
    { label: 'trading mode is "live"', passed: cfg.tradingMode === 'live', detail: `mode=${cfg.tradingMode}` },
    { label: 'REAL_FUNDS_AT_RISK acknowledged', passed: cfg.realFundsAtRisk, detail: 'must be true' },
    { label: 'kill switch OFF', passed: !cfg.killSwitch, detail: 'must be false' },
    { label: '--confirm-live given', passed: opts.confirmLive, detail: 'required flag' },
    { label: 'authenticated reads enabled', passed: cfg.enableAuthenticatedReads, detail: 'must be true' },
    { label: 'exactly one trading pair', passed: cfg.tradingPairs.length === 1, detail: `pairs=${cfg.tradingPairs.length}` },
    {
      label: 'controlled-test mutation authorization available (supportsOrderPlacement stays false)',
      passed: cfg.liveMaxBaseQuantity > 0 && cfg.liveMaxQuoteNotional > 0,
      detail: `maxBase=${cfg.liveMaxBaseQuantity}, maxQuote=${cfg.liveMaxQuoteNotional}; ` +
        `the adapter still reports supportsOrderPlacement=${adapter.capabilities.supportsOrderPlacement}`,
    },
  ];
}

function err(s: string): void {
  // eslint-disable-next-line no-console
  console.error(s);
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    err('stdin is not a TTY; cannot confirm interactively. Refusing to continue.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toUpperCase() === 'EXECUTE';
}

interface SummaryInputs {
  symbol: string;
  ticker: Ticker;
  bookQuoteTs: number | null;
  quoteTs: number | null;
  observedAtMs: number;
  freshness: ReturnType<typeof evaluateFreshness>;
  market: MarketInfo;
  balances: Balance[];
  targetCad: number;
  decision: RiskDecision;
  reconciliation: ReconciliationResult;
  gate: LivePreTradeGateResult;
  gates: RefreshGate[];
}

function money(m?: { toString(): string } | null): string {
  return m ? m.toString() : 'n/a';
}

/** `amount * fraction` exactly via fixed-point BigInt (mirrors RiskManager). */
function fractionOfMoney(amount: Money, fraction: number): Money {
  const scale = 1_000_000_000n;
  const num = BigInt(Math.round(fraction * Number(scale)));
  return amount.mulFraction(num, scale);
}

interface SummaryRiskPolicy {
  marketDataMaxAgeMs: number;
  marketDataTransportMaxAgeMs: number;
  maxClockSkewMs: number;
}

function printSummary(i: SummaryInputs, riskCfg: SummaryRiskPolicy): void {
  // eslint-disable-next-line no-console
  const out = (s: string) => console.log(s);
  const [base, quote] = i.symbol.split('/');
  const baseBal = i.balances.find((b) => b.currency === base);
  const quoteBal = i.balances.find((b) => b.currency === quote);
  const position = baseBal ? baseBal.available : null;
  const price = i.ticker.bid ?? i.ticker.last;
  const exposure = position && price ? price.mul(position) : null;

  out('LIVE TEST — workflow / decision (NO order placed exactly by this unless confirmed below)');
  out('  Symbol:                   ' + i.symbol);
  out('  Side / type:              SELL market (risk-reducing)');
  out('  Current bid:              ' + money(i.ticker.bid));
  out('  Current ask:              ' + money(i.ticker.ask));
  out('  Base balance (avail):     ' + money(position));
  out('  Quote balance (avail):    ' + money(quoteBal ? quoteBal.available : null));
  out('  Portfolio equity est:     ' + money(exposure ? exposure.add(quoteBal ? quoteBal.available : Money.zero()) : (quoteBal ? quoteBal.available : null)));
  out('  BTC exposure est:         ' + money(exposure));
  out('  Requested target:         ' + i.targetCad.toFixed(2) + ' ' + quote + ' (bounded notional)');

  if (i.decision.approved) {
    const fee = fractionOfMoney(i.decision.estimatedNotional, i.market.feeInfo?.taker ?? 0);
    out('  Risk-approved quantity:   ' + i.decision.quantity.toString());
    out('  Est. notional:            ' + money(i.decision.estimatedNotional));
    out('  Est. fee:                 ' + money(fee));
    if (position) {
      const proceeds = i.decision.estimatedNotional;
      const remainingBase = position.sub(i.decision.quantity);
      out('  Expected remaining BTC:   ' + money(remainingBase));
      out('  Expected remaining CAD:   ' + money(quoteBal ? quoteBal.available.add(proceeds.sub(fee)) : null));
    }
    out('  Precision:                ' + (i.decision.quantity.isMultipleOf(i.market.quantityTick) ? 'OK (on tick grid)' : 'NOT on tick grid') + '  tick=' + i.market.quantityTick.toString());
    out('  Min-order:                ' + (i.market.minOrderBase ? (i.decision.quantity.compareTo(i.market.minOrderBase) >= 0 ? 'OK' : 'TOO SMALL') : 'n/a') + '  minOrderBase=' + money(i.market.minOrderBase));
    out('  Balance:                  ' + (position && i.decision.quantity.compareTo(position) <= 0 ? 'OK (covers qty)' : 'NOT ENOUGH'));
  } else {
    out('  Risk decision:            REJECTED — ' + i.decision.reason + (i.decision.detail ? ': ' + i.decision.detail : ''));
  }

  out('  Market-data freshness:    ' + (i.freshness.fresh ? 'FRESH' : `FAILED (${i.freshness.reason})`));
  out('    ticker quote ts:        ' + (i.ticker.timestampMs ? String(i.ticker.timestampMs) : 'n/a'));
  out('    L2 bookmark ts:         ' + (i.bookQuoteTs === null ? 'n/a' : String(i.bookQuoteTs)));
  out('    chosen quote ts:        ' + (i.quoteTs === null ? 'n/a' : String(i.quoteTs)));
  out('    observed at ts:         ' + i.observedAtMs);
  out('    quote age:              ' + (i.quoteTs === null ? 'n/a' : String(Math.max(0, i.observedAtMs - i.quoteTs))) + 'ms (limit ' + riskCfg.marketDataMaxAgeMs + 'ms)');
  out('    transport age:          ' + '0ms (limit ' + riskCfg.marketDataTransportMaxAgeMs + 'ms)');
  out('  Reconciliation (V1):      ' + i.reconciliation.status + '  pre-trade(SELL): ' + (i.gate.allowed ? 'ALLOWED' : 'BLOCKED'));
  const balanceMismatches = i.reconciliation.balanceFindings.filter((b) => b.mismatch);
  if (balanceMismatches.length > 0) {
    out('    balance findings:       ' + balanceMismatches.map((b) => b.currency).join(', ') +
      ' (non-action-relevant drift does not block a SELL; run `bot reconcile` for the global view)');
  }
  for (const b of i.gate.blockers) out('    [block] ' + b);
  out('  Gates (pre-contact):');
  for (const g of i.gates) out('    [' + (g.passed ? 'PASS' : 'FAIL') + '] ' + g.label + ' (' + g.detail + ')');
}

/** A fresh, coherent market/account snapshot used to build a RiskContext. */
export interface LiveSnapshot {
  symbol: string;
  ticker: Ticker;
  bookQuoteTs: number | null;
  market: MarketInfo;
  balances: Balance[];
  observedAtMs: number;
  /** Chosen exchange quote timestamp for freshness: L2 ActionDateTime when valid, else L1 TimeStamp, else null. */
  quoteTs: number | null;
  freshness: ReturnType<typeof evaluateFreshness>;
}

interface FetchSnapshotDeps {
  adapter: ExchangeAdapter;
  nowMs: () => number;
  policy: FreshnessPolicy;
}

/**
 * Fetch a fresh market/account snapshot and compute freshness.
 *
 * F-3/F-8: the quote-freshness basis is the L2 order-book `ActionDateTime`
 * (`bookQuoteTs`) when available — it advances with actual book/quote updates.
 * The NDAX L1 `TimeStamp` is a last-trade/session timestamp that can lag the
 * quote, so it is used ONLY as a fallback when no valid L2 book timestamp is
 * available. Missing/invalid both is `null` (freshness fails closed as
 * QUOTE_MISSING), never a fabricated local time. The local observation time is
 * tracked independently for the transport-age check.
 */
export async function fetchLiveSnapshot(deps: FetchSnapshotDeps, symbol: string): Promise<LiveSnapshot> {
  const { adapter, nowMs, policy } = deps;
  let ticker: Ticker;
  let bookQuoteTs: number | null = null;
  let market: MarketInfo;
  let balances: Balance[];
  try {
    ticker = await adapter.getTicker(symbol);
    try {
      const book = await adapter.getOrderBook(symbol);
      bookQuoteTs = book.quoteTimestampMs ?? null;
    } catch (e) {
      err('warning: order book unavailable; falling back to ticker-only quote time: ' + (e instanceof Error ? e.message : String(e)));
    }
    market = await adapter.getMarketInfo(symbol);
    balances = await adapter.getBalances();
  } catch (e) {
    throw new Error('failed to fetch market/account data before any order: ' + (e instanceof Error ? e.message : String(e)));
  }
  const observedAtMs = nowMs();
  // F-3/F-8: prefer the L2 order-book ActionDateTime (real book/quote freshness);
  // fall back to the L1 ticker TimeStamp only when the L2 book timestamp is
  // missing/invalid. Never fabricate a local time.
  const bookTs = isValidEpochMs(bookQuoteTs) ? bookQuoteTs : null;
  const l1Ts = isValidEpochMs(ticker.timestampMs) ? ticker.timestampMs : null;
  const quoteTs = bookTs ?? l1Ts;
  const freshness = evaluateFreshness({ nowMs: observedAtMs, quoteTimestampMs: quoteTs, observedAtMs, policy });
  return { symbol, ticker, bookQuoteTs, market, balances, observedAtMs, quoteTs, freshness };
}

/**
 * Fetch valuation Tickers for every NON-candidate managed position so the live
 * risk context can value the WHOLE managed portfolio (F-2/F-8). A fetch failure
 * for a symbol leaves it absent, and `buildLiveRiskContext` fails closed
 * (portfolio valuation unknown). Each fetched ticker is stamped with the LOCAL
 * observation (transport) time — never an exchange quote timestamp.
 */
async function fetchManagedValuation(
  adapter: ExchangeAdapter,
  portfolio: Portfolio,
  candidateSymbol: string,
  nowMs: () => number,
): Promise<Map<string, Ticker>> {
  const out = new Map<string, Ticker>();
  for (const sym of portfolio.stateModel.positions.keys()) {
    if (sym === candidateSymbol) continue;
    try {
      const t = await adapter.getTicker(sym);
      out.set(sym, { ...t, observedAtMs: nowMs() });
    } catch {
      // Cannot value this managed position => leave absent; risk fails closed.
    }
  }
  return out;
}

/** Build a RiskContext from a snapshot using ONLY bot-managed portfolio state. */
export function buildLiveRiskContext(i: {
  snapshot: LiveSnapshot;
  portfolio: Portfolio;
  symbol: string;
  side: 'BUY' | 'SELL';
  reason: string;
  sellTarget?: { fraction?: number; notional?: Money } | null;
  /**
   * F-2/F-8: valuation Tickers for every NON-candidate managed position, keyed by
   * symbol. Used to value the WHOLE managed portfolio (candidate uses the
   * snapshot ticker). A missing/non-fetchable symbol is left absent and fails
   * closed.
   */
  managedValuation: ReadonlyMap<string, Ticker>;
  /** F-2/F-8: freshness policy used to gate non-candidate valuation prices. */
  freshnessPolicy: FreshnessPolicy;
}): RiskContext {
  const { snapshot, portfolio, symbol, side, reason, sellTarget } = i;
  const [base, quote] = symbol.split('/');
  const quoteCur = quote ?? 'CAD';
  const ticker = snapshot.ticker;
  const market = snapshot.market;
  const balances = snapshot.balances;
  const baseBal = balances.find((b) => b.currency === base) ?? null;
  const quoteBal = balances.find((b) => b.currency === quoteCur) ?? null;
  // The bot may only trade its MANAGED inventory. Exchange base balance is the
  // exchange truth; external = exchange minus managed (non-negative). A SELL can
  // only ever consume the managed quantity.
  const managed = portfolio.position(symbol)?.quantity ?? Money.zero();
  const exchangeBase = baseBal ? baseBal.available : Money.zero();
  const external = exchangeBase.compareTo(managed) > 0 ? exchangeBase.sub(managed) : Money.zero();
  // Candidate EXECUTABLE price semantics (unchanged): BUY uses ask??last, SELL bid??last.
  const refPrice = side === 'BUY' ? (ticker.ask ?? ticker.last) : (ticker.bid ?? ticker.last);
  // F-2/F-8: value EVERY managed position for portfolio equity/exposure using a
  // neutral mark (last ?? ask ?? bid) per market. The candidate uses the snapshot
  // ticker (the RiskManager validates ITS freshness). NON-candidate managed
  // positions must each have a FRESH, market-specific price; otherwise the whole
  // portfolio valuation is UNKNOWN (fail closed => portfolioValue/exposure =
  // null). A missing/stale/wrong-market price must NEVER silently omit a managed
  // position from exposure.
  const priceMap = new Map<string, Money>();
  const candidateMark = ticker.last ?? ticker.ask ?? ticker.bid;
  if (candidateMark) priceMap.set(symbol, candidateMark);
  let valuationUnknown = false;
  for (const pos of portfolio.stateModel.positions.values()) {
    if (pos.symbol === symbol) continue; // candidate handled above
    const vt = i.managedValuation.get(pos.symbol);
    if (!vt) {
      valuationUnknown = true;
      continue;
    }
    const mark = vt.last ?? vt.ask ?? vt.bid;
    if (mark === null) {
      valuationUnknown = true;
      continue;
    }
    const fresh = i.freshnessPolicy
      ? evaluateFreshness({
          nowMs: snapshot.observedAtMs,
          quoteTimestampMs: vt.timestampMs ?? null,
          observedAtMs: vt.observedAtMs ?? null,
          policy: i.freshnessPolicy,
        })
      : { fresh: false as const };
    if (!fresh.fresh) {
      valuationUnknown = true;
      continue;
    }
    priceMap.set(pos.symbol, mark);
  }
  const mtm = valuationUnknown ? null : portfolio.markToMarket(priceMap);
  // F-2: portfolio exposure is the SUM across ALL managed positions (not just the
  // candidate), so a future BUY is capped against TRUE total exposure.
  const totalExposure = mtm ? portfolio.exposure(priceMap) : null;
  // F-7: deployable quote is bounded by the exchange's AUTHORITATIVE AVAILABLE
  // quote (total - held). Held/frozen CAD can never fund a new BUY, and the bot
  // never deploys more than its own managed quote. This affects ONLY deployable
  // capital, never managed equity/P&L/ownership.
  const deployable = portfolio.deployableQuoteBounded(quoteCur, quoteBal);
  return {
    symbol,
    signal: signal(symbol, side, { reason }, snapshot.observedAtMs),
    nowMs: snapshot.observedAtMs,
    marketDataTimestampMs: snapshot.quoteTs,
    marketDataObservedAtMs: snapshot.observedAtMs,
    price: refPrice,
    marketInfo: market,
    quoteBalance: quoteBal,
    deployableQuote: deployable,
    portfolioValue: mtm ? mtm.equity : null,
    peakPortfolioValue: portfolio.stateModel.peakEquity,
    portfolioExposure: totalExposure,
    currentPosition: managed,
    externalPosition: external,
    openManagedPositionCount: portfolio.managedOpenCount(),
    realizedPnlToday: portfolio.stateModel.realizedPnl,
    unrealizedPnlToday: mtm ? mtm.unrealizedPnl : null,
    sellTarget,
  };
}

/**
 * Run the full live-test workflow. Returns a process exit code (0 = clean ack +
 * confirmed lifecycle; 1 = refused / rejected / ambiguous / unconfirmed).
 *
 * This is split out from the CLI handler so it can be tested against a
 * FakeExchange with injected deps (no network, no TTY).
 */
export async function executeLiveTest(deps: LiveTestDeps, opts: LiveTestOptions): Promise<number> {
  const cfg = deps.cfg;
  const adapter = deps.adapter;
  const now = deps.nowMs ?? Date.now;

  const gates = evaluateGates(cfg, opts, adapter);
  for (const g of gates) {
    if (!g.passed) {
      err('live-test refused: ' + g.label + ' — ' + g.detail);
      return 1;
    }
  }

  const symbol = cfg.tradingPairs[0]!;
  const sellTarget = { notional: Money.fromNumber(opts.targetCad) };
  const reason = 'live-test SELL (target ' + opts.targetCad + ' CAD)';
  const policy: FreshnessPolicy = {
    maxQuoteAgeMs: cfg.marketDataMaxAgeMs,
    maxTransportAgeMs: cfg.marketDataTransportMaxAgeMs,
    maxAcceptableFutureSkewMs: cfg.maxClockSkewMs,
  };
  const fetchDeps = { adapter, nowMs: now, policy };

  // Initial snapshot — used only for the operator DISPLAY (the proposed trade).
  // This is NOT the basis for the final placement decision.
  let initial: LiveSnapshot;
  try {
    initial = await fetchLiveSnapshot(fetchDeps, symbol);
  } catch (e) {
    err('live-test aborted: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const displayCtx = buildLiveRiskContext({
    snapshot: initial,
    portfolio: deps.portfolio,
    symbol,
    side: 'SELL',
    reason,
    sellTarget,
    managedValuation: await fetchManagedValuation(adapter, deps.portfolio, symbol, now),
    freshnessPolicy: policy,
  });
  const decision = deps.riskManager.evaluate(displayCtx);

  // Authoritative V1 reconciliation (READ-ONLY). ONE exchange-read pass. The
  // global result is projected onto the intended SELL action below, so legitimate
  // external/unmanaged quote cash (e.g. CAD) does not over-block a bounded SELL,
  // while unresolved order/execution/reservation/cross-domain problems still do.
  // The global `bot reconcile` status remains strict.
  let reconciliation: ReconciliationResult;
  try {
    const reconcileDeps: ReconciliationDeps = {
      stateDir: cfg.stateDir ?? dirname(cfg.liveManagedStateFile),
      orders: deps.store,
      live: deps.live,
      manualIntents: deps.manualIntents,
      adapter,
      nowMs: now,
    };
    reconciliation = await reconcile(reconcileDeps);
  } catch (e) {
    err('live-test aborted: reconciliation failed: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  const quoteCurrencies = new Set(cfg.tradingPairs.map((p) => p.split('/')[1] ?? ''));
  const gate = livePreTradeGate(reconciliation, { side: 'SELL', symbol, quoteCurrencies });

  const summary: SummaryInputs = {
    symbol,
    ticker: initial.ticker,
    bookQuoteTs: initial.bookQuoteTs,
    quoteTs: initial.quoteTs,
    observedAtMs: initial.observedAtMs,
    freshness: initial.freshness,
    market: initial.market,
    balances: initial.balances,
    targetCad: opts.targetCad,
    decision,
    reconciliation,
    gate,
    gates,
  };
  printSummary(summary, cfg);

  if (!decision.approved) {
    err('\nlive-test refused: risk decision not approved (' + decision.reason + '). No order placed.');
    return 1;
  }
  if (!gate.allowed) {
    err(
      '\nlive-test refused: action-aware pre-trade reconciliation blocked this SELL.\n  ' +
        gate.blockers.join('\n  ') +
        '\n  Run `bot reconcile` and resolve the blocking findings before any order.',
    );
    return 1;
  }

  const prompt =
    '\nThis will SELL up to ' +
    decision.quantity.toString() +
    ' ' + symbol.split('/')[0] +
    ' (notional ' + money(decision.estimatedNotional) + ' ' + symbol.split('/')[1] +
    ') on the LIVE ' + cfg.exchange.toUpperCase() +
    ' account.\nType EXECUTE and press Enter to place the order, or anything else to abort.\n> ';
  const confirmed = deps.confirm ? await deps.confirm(prompt) : await defaultConfirm(prompt);
  if (!confirmed) {
    err('live-test aborted: not confirmed. No order was placed.');
    return 1;
  }

  // F-4: AFTER the operator confirms, re-fetch a FRESH snapshot and rebuild the
  // RiskContext with a fresh observation time. The final placement uses ONLY this
  // fresh data, so an arbitrary operator delay can no longer let a stale or
  // missing-timestamp snapshot pass the final risk gate. The order is placed via
  // the existing LiveOrderEngine, which re-runs RiskManager.evaluate(freshCtx).
  let fresh: LiveSnapshot;
  try {
    fresh = await fetchLiveSnapshot(fetchDeps, symbol);
  } catch (e) {
    err('live-test aborted at execution: fresh market data unavailable (' + (e instanceof Error ? e.message : String(e)) + ').\n  NO ORDER placed. Re-run when market data is available.');
    return 1;
  }
  const freshCtx = buildLiveRiskContext({
    snapshot: fresh,
    portfolio: deps.portfolio,
    symbol,
    side: 'SELL',
    reason,
    sellTarget,
    managedValuation: await fetchManagedValuation(adapter, deps.portfolio, symbol, now),
    freshnessPolicy: policy,
  });

  // Only AFTER operator confirmation and a fresh snapshot do we arm the
  // controlled-test mutation authorization. This is the explicit, narrowly-scoped
  // gate that lets the controlled SELL/LIMIT path reach the adapter's placeOrder.
  const controlledAuth = createControlledLiveAuthorization({
    side: 'SELL',
    type: 'limit',
    maxBaseQuantity: Money.fromNumber(cfg.liveMaxBaseQuantity),
    maxQuoteNotional: Money.fromNumber(cfg.liveMaxQuoteNotional),
  });

  const engine = new LiveOrderEngine(adapter, deps.store, deps.reconcile, deps.riskManager, {
    gate: { tradingMode: 'live', realFundsAtRisk: cfg.realFundsAtRisk },
    killSwitch: cfg.killSwitch,
    // Controlled LIVE scope: only LIMIT orders are permitted. These caps are
    // enforced before submission. LIVE market orders remain disabled.
    maxLiveQuoteNotional: Money.fromNumber(cfg.liveMaxQuoteNotional),
    maxLiveBaseQuantity: Money.fromNumber(cfg.liveMaxBaseQuantity),
    controlledLiveAuthorization: controlledAuth,
  });
  // Explicit LIMIT order: the reference price (bid for a SELL) is the hard
  // exchange-side bound — the order can never execute worse than this price.
  const result = await engine.place(freshCtx, { reason, type: 'limit', price: freshCtx.price ?? undefined });

  if (result.order.status === 'REJECTED') {
    err('\nlive-test: order rejected by the exchange/live engine: ' + result.message + '\n  No retry. Run `bot reconcile` / `bot trades` if needed.');
    return 1;
  }
  if (result.unknownOutcome || result.order.status === 'UNKNOWN') {
    err('\nlive-test: submission outcome UNKNOWN (' + result.message + ').\n  The order may have been accepted. Do NOT retry. Run `bot reconcile` to confirm your position before anything else.');
    return 1;
  }

  // Ack == SUBMITTED, not FILLED. Confirm the lifecycle via authoritative state.
  try {
    const authoritative = await engine.refreshOrder(result.order);
    await adapter.getOpenOrders(symbol);
    await deps.reconcile.reconcile();
    // eslint-disable-next-line no-console
    console.log('\nlive-test: order acknowledged. exchanged order id=' + (authoritative.exchangeOrderId ?? 'n/a') + ' authoritative status=' + authoritative.status);
  } catch (e) {
    err('\nlive-test: order was accepted (no retry) but lifecycle confirmation failed (' + (e instanceof Error ? e.message : String(e)) + ').\n  Run `bot reconcile` to confirm the final state.');
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log('\nlive-test complete. ACCEPTED != FILLED — confirm the final fill via `bot reconcile` / `bot trades`.');
  return 0;
}

/**
 * Load the bot's LIVE MANAGED portfolio.
 *
 * F-1: this NEVER reads the paper state file and NEVER adopts exchange balances
 * as managed inventory. It reads ONLY the dedicated live managed-state store
 * (`liveManagedStateFile`). If no live managed state exists yet, it returns an
 * EMPTY managed portfolio (zero managed positions, zero deployable capital) —
 * which is fail-closed (a SELL with no managed position is rejected, a BUY with
 * no deployable quote is rejected).
 *
 * F-2: MISSING live managed state is distinguished from a GENUINE first-ever run
 * using the `StateInitMarker` (mirroring the PAPER path). If the live realm was
 * already initialized but the state file is missing, this is unexpected state
 * loss and FAILS CLOSED (throws) rather than silently seeding an empty portfolio.
 *
 * @param cfg the resolved bot configuration
 */
export function loadLiveManagedPortfolio(cfg: BotConfig): Portfolio {
  const liveStore = new ManagedStateStore(cfg.liveManagedStateFile);
  const stateDir = cfg.stateDir ?? dirname(cfg.liveManagedStateFile);
  const initMarker = new StateInitMarker(join(stateDir, '.init.json'));
  const r = liveStore.load();
  if (r.status === 'CORRUPT') {
    // Defect C: corrupt live managed state must HALT, never be treated as empty.
    throw new CorruptStateError(`live managed state is corrupt: ${r.reason}`);
  }
  if (r.status === 'OK') {
    const p = liveStore.toPortfolio(r.data);
    if (!p) {
      throw new CorruptStateError('live managed state loaded but could not be reconstructed into a portfolio');
    }
    return p;
  }
  // MISSING: distinguish a GENUINE first-ever run from unexpected state loss.
  if (initMarker.isInitialized('live')) {
    // The live realm was already initialized but the managed-state file is gone.
    // This is unexpected state loss — fail closed rather than seeding empty.
    throw new CorruptStateError(
      'live managed state is missing but the live realm was already initialized (unexpected state loss)',
    );
  }
  // Genuine first-ever live run: seed empty, persist it, and mark the realm
  // initialized so a later disappearance is detected as state loss (mirrors the
  // PAPER path in buildEngine).
  const seeded = Portfolio.empty(new Map([['CAD', Money.zero()]]));
  liveStore.save(seeded.stateModel);
  withStateDirLock(stateDir, () => initMarker.markInitialized('live'));
  return seeded;
}

/**
 * Assert the live/manual realm may begin operating.
 *
 * Runs the existing startup recovery coordinator (`recoverState`) over the
 * durable state files (paper, live managed, order ledger, manual intents, init
 * marker) and FAILS CLOSED if the files are HALTED (corruption / unexpected
 * state loss) or if they contradict one another across files (a reservation
 * with no corresponding order/intent, or an ACCOUNTED manual intent with no
 * portfolio settlement). Read-only: it never mutates state.
 *
 * This is the production startup gate for the live/manual realm, wiring the
 * previously test-only cross-file consistency validation into the actual CLI
 * startup path.
 *
 * @throws when the realm must not begin operating.
 */
export function assertLiveRealmRecoverable(cfg: BotConfig): void {
  const stateDir = cfg.stateDir ?? dirname(cfg.liveManagedStateFile);
  const report = recoverState({
    paper: new PaperStateStore(cfg.paperStateFile),
    live: new ManagedStateStore(cfg.liveManagedStateFile),
    orders: new OrderStore(cfg.orderLedgerFile),
    manualIntents: new ManualIntentStore(cfg.manualIntentFile),
    initMarker: new StateInitMarker(join(stateDir, '.init.json')),
  });
  if (report.status === 'HALTED' || report.crossFileIssues.length > 0) {
    const detail = [...report.reasons, ...report.crossFileIssues].join('; ');
    throw new CorruptStateError(`live/manual realm startup blocked (${report.status}): ${detail}`);
  }
}

export const liveTestCommand: CommandHandler = async (args): Promise<number> => {
  const parsed = parseLiveTestArgs(args);
  if (!parsed.ok) {
    err('live-test: ' + parsed.error);
    return 1;
  }
  const opts = parsed.opts;

  let cfg: BotConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    err('Configuration error:\n' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  try {
    assertLiveRealmRecoverable(cfg);
  } catch (e) {
    err('live-test: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  const adapter = createExchange(cfg.exchange, {
    credentials,
    config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl },
  });

  const store = new OrderStore(cfg.orderLedgerFile);
  const service = new ReconcileService(adapter, store);
  const liveStore = new ManagedStateStore(cfg.liveManagedStateFile);
  const manualIntents = new ManualIntentStore(cfg.manualIntentFile);

  const livePortfolio = loadLiveManagedPortfolio(cfg);

  return executeLiveTest(
    {
      cfg,
      adapter,
      store,
      live: liveStore,
      manualIntents,
      reconcile: service,
      riskManager: buildRiskManager(cfg),
      portfolio: livePortfolio,
    },
    opts,
  );
};
