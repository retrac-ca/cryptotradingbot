/**
 * `bot manual` — the CONSTRAINED MANUAL EXECUTION BRIDGE CLI.
 *
 * This is an OPERATOR INTERFACE around the existing Gate 9 manual-execution
 * safety model. It is NOT a trading terminal, NOT an order-placement interface,
 * NOT an automated execution engine, and NOT an exchange control panel. RETRAC
 * NEVER places, cancels, or modifies an exchange order through this command.
 *
 * SAFETY CONTRACT (enforced structurally + by convention):
 *   - The exchange adapter handed to this command is wrapped in a read-only
 *     proxy that throws on `placeOrder`/`cancelOrder`. No `bot manual` code path
 *     can reach an exchange write method.
 *   - `supportsOrderPlacement` remains `false` on the NDAX adapter.
 *   - No autonomous trading / no live BUY loop / no automatic placement.
 *   - Operator-entered evidence is a HINT, never authoritative. Authority comes
 *     only from an exchange read.
 *   - An external OrderId is evidence + consistency validation, NOT provenance
 *     proof. `provenanceProof` is always `false`.
 *   - Fee currency is NEVER inferred. A non-zero fee that cannot be
 *     authoritatively accounted -> RECONCILIATION_REQUIRED, never an
 *     accounting-success state, never silently treated as quote.
 *
 * Exit codes: 0 = completed safely; 2 = blocked/fail-closed (RECONCILIATION_REQUIRED,
 * AMBIGUOUS, PENDING, not safe-to-trade, refused); 1 = error (config, not found,
 * invalid args/transition, exchange read failure, corrupt store).
 */

import { createInterface } from 'node:readline';
import type { Logger } from '../logging/logger.js';
import { Money } from '../money/Money.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import { createExchange } from '../exchanges/index.js';
import { loadConfig } from '../config/load.js';
import type { BotConfig } from '../config/schema.js';
import type { Order } from '../order.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { ManagedStateStore } from '../persistence/index.js';
import type { RiskManager } from '../risk/RiskManager.js';
import type { RiskContext } from '../risk/RiskContext.js';
import { buildRiskManager } from '../risk/index.js';
import type { AccountTrade, Ticker } from '../types.js';
import type { FreshnessPolicy } from '../marketdata/index.js';
import {
  ManualIntentStore,
  ManualTradeBridge,
  bindOrderToIntent,
} from '../manual/index.js';
import type {
  ManualTradeIntent,
  SettleOutcome,
  AccountingAuthority,
  RecordEvidenceInput,
} from '../manual/index.js';
import { fetchLiveSnapshot, buildLiveRiskContext, loadLiveManagedPortfolio, assertLiveRealmRecoverable } from './live-test-cmd.js';
import type { LiveSnapshot } from './live-test-cmd.js';
import type { CommandHandler } from './context.js';

/** A resolved fee currency (structurally matches NDAX `FeeAssetResolution`). */
export interface ResolvedFee {
  kind: 'base' | 'quote' | 'other' | 'unknown';
  currency: 'base' | 'quote' | 'unknown';
  assetSymbol: string | null;
  feeProductId: string | null;
  reason?: string;
}

/** An adapter that MAY additionally expose a read-only fee-currency resolver. */
export type FeeCtx = ExchangeAdapter & { resolveFeeCurrency?: (feeProductId: string | null | undefined, symbol: string) => Promise<ResolvedFee> };

/**
 * Wrap a write-capable adapter in a read-only proxy (runtime structural guard).
 * Reads delegate to the underlying adapter; `placeOrder`/`cancelOrder` throw.
 */
export function toReadOnlyAdapter(adapter: ExchangeAdapter): FeeCtx {
  const writeKeys = new Set<string>(['placeOrder', 'cancelOrder']);
  const proxy = new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && writeKeys.has(prop)) {
        return async () => {
          throw new Error('CLI safety guard: exchange write methods are disabled on `bot manual`');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy as FeeCtx;
}

/** Dependencies for the testable manual-cli core (adapter is already read-only). */
export interface ManualCliDeps {
  cfg: BotConfig;
  adapter: FeeCtx;
  bridge: ManualTradeBridge;
  getPortfolio: () => Portfolio;
  riskManager: RiskManager;
  nowMs?: () => number;
  confirm?: (message: string) => Promise<boolean>;
  logger?: Logger;
}

interface CliCommandResult {
  code: number;
  lines: string[];
  json: Record<string, unknown>;
}

const ok = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 0, lines, json });
const blocked = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 2, lines, json });
const failed = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 1, lines, json });

function feePolicy(cfg: BotConfig): FreshnessPolicy {
  return {
    maxQuoteAgeMs: cfg.marketDataMaxAgeMs,
    maxTransportAgeMs: cfg.marketDataTransportMaxAgeMs,
    maxAcceptableFutureSkewMs: cfg.maxClockSkewMs,
  };
}

function intentNotFound(intentId: string): CliCommandResult {
  return failed(['intent not found: ' + intentId], { error: 'intent_not_found', intentId });
}

// ---------------------------------------------------------------------------
// Fee classification (display only; never infers quote).
// ---------------------------------------------------------------------------

export type FeeDisplayStatus =
  | 'AUTHORITATIVE_QUOTE'
  | 'BASE'
  | 'OTHER'
  | 'UNKNOWN'
  | 'MISSING'
  | 'UNRESOLVED'
  | 'OPERATOR_HINT';

export interface FeeDisplay {
  amount: string | null;
  status: FeeDisplayStatus;
  currency: 'quote' | 'base' | 'other' | 'unknown' | null;
  productId: string | null;
  assetSymbol: string | null;
  evidence: string;
}

function classifyFee(amount: Money | null, currency: 'base' | 'quote' | 'unknown' | null): FeeDisplay {
  if (amount === null || !amount.isPositive()) {
    return {
      amount: amount ? amount.toString() : '0',
      status: 'MISSING',
      currency,
      productId: null,
      assetSymbol: null,
      evidence: 'no authoritative fee amount was reported',
    };
  }
  if (currency === 'quote') {
    return { amount: amount.toString(), status: 'AUTHORITATIVE_QUOTE', currency, productId: null, assetSymbol: null, evidence: 'authoritative quote fee (usable by the quote-only settlement path)' };
  }
  if (currency === 'base') {
    return { amount: amount.toString(), status: 'BASE', currency, productId: null, assetSymbol: null, evidence: 'authoritative BASE fee — NOT usable by the quote-only settlement path (never converted)' };
  }
  return { amount: amount.toString(), status: 'UNKNOWN', currency: 'unknown', productId: null, assetSymbol: null, evidence: 'fee currency unknown — accounting cannot be completed safely (RECONCILIATION_REQUIRED)' };
}

function classifyAccountTradeFee(t: AccountTrade, resolved?: ResolvedFee): FeeDisplay {
  if (!t.fee.isPositive()) return { amount: '0', status: 'MISSING', currency: null, productId: t.feeProductId, assetSymbol: null, evidence: 'no fee reported on this trade record' };
  if (!resolved) return { amount: t.fee.toString(), status: 'UNRESOLVED', currency: null, productId: t.feeProductId, assetSymbol: null, evidence: 'feeProductId present but fee currency could not be resolved in this environment' };
  if (resolved.kind === 'quote') return { amount: t.fee.toString(), status: 'AUTHORITATIVE_QUOTE', currency: 'quote', productId: t.feeProductId, assetSymbol: resolved.assetSymbol, evidence: 'authoritative quote fee (resolved from feeProductId)' };
  if (resolved.kind === 'base') return { amount: t.fee.toString(), status: 'BASE', currency: 'base', productId: t.feeProductId, assetSymbol: resolved.assetSymbol, evidence: 'authoritative BASE fee (never converted)' };
  if (resolved.kind === 'other') return { amount: t.fee.toString(), status: 'OTHER', currency: 'other', productId: t.feeProductId, assetSymbol: resolved.assetSymbol, evidence: 'fee charged in a third asset, not base/quote' };
  return { amount: t.fee.toString(), status: 'UNKNOWN', currency: 'unknown', productId: t.feeProductId, assetSymbol: null, evidence: resolved.reason ?? 'fee currency not authoritatively resolvable' };
}

// ---------------------------------------------------------------------------
// Structured state for a manual intent (JSON + display source of truth).
// ---------------------------------------------------------------------------

function feeOfIntent(intent: ManualTradeIntent, deps: ManualCliDeps): FeeDisplay {
  const settlement = deps.getPortfolio().manualSettlement(intent.intentId);
  // The settled fee is ALWAYS quote (only a quote fee can be accounted) — never inferred.
  if (settlement) return classifyFee(settlement.fee, 'quote');
  const ev = intent.evidence;
  if (ev && ev.fee) {
    return { amount: ev.fee.toString(), status: 'OPERATOR_HINT', currency: ev.feeCurrency, productId: null, assetSymbol: null, evidence: 'operator-reported hint only — never used as authoritative' };
  }
  return { amount: null, status: 'MISSING', currency: null, productId: null, assetSymbol: null, evidence: 'no fee recorded' };
}

function buildState(deps: ManualCliDeps, intent: ManualTradeIntent): Record<string, unknown> {
  const pf = deps.getPortfolio();
  const settlement = pf.manualSettlement(intent.intentId);
  const reservation = pf.orderReservation(intent.intentId);
  const fee = feeOfIntent(intent, deps);
  return {
    intentId: intent.intentId,
    state: intent.status,
    symbol: intent.symbol,
    side: intent.side,
    type: intent.type,
    requestedQuantity: intent.quantity.toString(),
    executedQuantity: settlement ? settlement.quantity.toString() : (intent.evidence?.filledQuantity ? intent.evidence.filledQuantity.toString() : null),
    price: settlement ? settlement.price.toString() : (intent.evidence?.averagePrice ? intent.evidence.averagePrice.toString() : null),
    limitPrice: intent.limitPrice ? intent.limitPrice.toString() : null,
    orderState: intent.evidence?.status ?? null,
    orderId: intent.evidence?.orderId ?? null,
    evidenceSource: intent.evidence?.evidenceSource ?? null,
    executionIds: [], // observed only via `manual verify`; never fabricated
    settlementMode: settlement?.settlementMode ?? null,
    accountingAuthority: settlement?.settlementMode === 'operator_attested' ? 'operator_attestation' : (settlement?.settlementMode === 'exchange_validated' ? 'exchange' : null),
    provenanceProof: false, // ALWAYS false
    exchangeValidated: settlement?.exchangedValidated ?? null,
    operatorAttested: settlement?.settlementMode === 'operator_attested' || (intent.evidence?.evidenceSource === 'operator' && intent.operatorConfirmedBy !== null),
    fee,
    reservation: reservation
      ? { status: reservation.status, currency: reservation.currency, amount: reservation.amount.toString(), remaining: reservation.remaining.toString() }
      : null,
    createdAtMs: intent.createdAtMs,
    updatedAtMs: intent.updatedAtMs,
    operatorConfirmedBy: intent.operatorConfirmedBy,
  };
}

function renderHeader(intent: ManualTradeIntent): string[] {
  return [
    'MANUAL EXECUTION BRIDGE (operator-executed; RETRAC places no exchange order)',
    'Identity:',
    '  intentId:                 ' + intent.intentId,
    '  orderId (evidence):       ' + (intent.evidence?.orderId ?? 'not recorded'),
    '  provenanceProof:          false (OrderId is evidence, NOT provenance proof)',
    '',
    'Trade:',
    '  symbol:                   ' + intent.symbol,
    '  side/type:                ' + intent.side + ' ' + intent.type,
    '  requested quantity:       ' + intent.quantity.toString(),
    '  limit price:              ' + (intent.limitPrice ? intent.limitPrice.toString() : '(market)'),
    '  reason:                   ' + intent.reason,
    '  current state:            ' + intent.status,
  ];
}

// ---------------------------------------------------------------------------
// Args parsing
// ---------------------------------------------------------------------------

interface ProposeArgs {
  symbol: string;
  side: 'BUY' | 'SELL';
  reason: string;
  limitPrice: Money | null;
  sellTargetCad: number | null;
}

function parseProposeArgs(args: string[]): { ok: true; opts: ProposeArgs } | { ok: false; error: string } {
  const opts: ProposeArgs = { symbol: 'BTC/CAD', side: 'BUY', reason: 'manual-propose (operator-initiated)', limitPrice: null, sellTargetCad: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--symbol') { const v = args[++i]; if (!v) return { ok: false, error: '--symbol requires a value' }; opts.symbol = v.toUpperCase(); }
    else if (a === '--side') { const v = args[++i]; if (v !== 'BUY' && v !== 'SELL') return { ok: false, error: '--side must be BUY or SELL' }; opts.side = v; }
    else if (a === '--reason') { opts.reason = args[++i] ?? opts.reason; }
    else if (a === '--limit-price') { const v = args[++i]; if (!v) return { ok: false, error: '--limit-price requires a value' }; opts.limitPrice = Money.fromString(v); }
    else if (a === '--sell-target-cad') { const v = args[++i]; const n = Number(v); if (v === undefined || !Number.isFinite(n) || n <= 0) return { ok: false, error: '--sell-target-cad requires a positive number' }; opts.sellTargetCad = n; }
    else if (a === '--json') { /* handled globally */ }
    else return { ok: false, error: 'unknown argument "' + a + '". Usage: bot manual propose --symbol <SYM> --side BUY|SELL [--reason <text>] [--limit-price <X>] [--sell-target-cad <N>] [--json]' };
  }
  return { ok: true, opts };
}

interface EvidenceArgs {
  orderId: string;
  status: string | null;
  filledQuantity: Money | null;
  averagePrice: Money | null;
  fee: Money | null;
  feeCurrency: 'base' | 'quote';
  source: 'operator' | 'exchange_read' | 'ndax_ui' | 'ndax_api' | 'other';
  note?: string;
}

function parseEvidenceArgs(args: string[]): { ok: true; opts: EvidenceArgs } | { ok: false; error: string } {
  const opts: EvidenceArgs = { orderId: '', status: null, filledQuantity: null, averagePrice: null, fee: null, feeCurrency: 'quote', source: 'operator' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--order-id') { const v = args[++i]; if (!v) return { ok: false, error: '--order-id requires a value' }; opts.orderId = v; }
    else if (a === '--status') { opts.status = args[++i] ?? null; }
    else if (a === '--filled-qty') { const v = args[++i]; if (!v) return { ok: false, error: '--filled-qty requires a value' }; opts.filledQuantity = Money.fromString(v); }
    else if (a === '--avg-price') { const v = args[++i]; if (!v) return { ok: false, error: '--avg-price requires a value' }; opts.averagePrice = Money.fromString(v); }
    else if (a === '--fee') { const v = args[++i]; if (!v) return { ok: false, error: '--fee requires a value' }; opts.fee = Money.fromString(v); }
    else if (a === '--fee-currency') { const v = args[++i]; if (v !== 'base' && v !== 'quote') return { ok: false, error: '--fee-currency must be base or quote' }; opts.feeCurrency = v; }
    else if (a === '--source') { const v = args[++i]; if (!v || !['operator', 'exchange_read', 'ndax_ui', 'ndax_api', 'other'].includes(v)) return { ok: false, error: '--source must be one of operator|exchange_read|ndax_ui|ndax_api|other' }; opts.source = v as EvidenceArgs['source']; }
    else if (a === '--note') { opts.note = args[++i]; }
    else if (a === '--json') { /* handled globally */ }
    else return { ok: false, error: 'unknown argument "' + a + '". Usage: bot manual evidence <intentId> --order-id <X> [--status ST] [--filled-qty Q] [--avg-price P] [--fee F] [--fee-currency base|quote] [--source S] [--note <text>] [--json]' };
  }
  if (!opts.orderId) return { ok: false, error: '--order-id is required to record external evidence' };
  return { ok: true, opts };
}

interface SettleArgs {
  authority: AccountingAuthority;
  confirm: boolean;
  operator: string | null;
}

function parseSettleArgs(args: string[]): { ok: true; opts: SettleArgs } | { ok: false; error: string } {
  const opts: SettleArgs = { authority: 'exchange', confirm: false, operator: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--accounting-authority') { const v = args[++i]; if (v !== 'exchange' && v !== 'operator_attestation') return { ok: false, error: '--accounting-authority must be exchange or operator_attestation' }; opts.authority = v; }
    else if (a === '--confirm') { opts.confirm = true; }
    else if (a === '--operator') { opts.operator = args[++i] ?? null; }
    else if (a === '--json') { /* handled globally */ }
    else return { ok: false, error: 'unknown argument "' + a + '". Usage: bot manual settle <intentId> [--accounting-authority exchange|operator_attestation] [--confirm] [--operator <name>] [--json]' };
  }
  return { ok: true, opts };
}

interface CancelArgs {
  confirm: boolean;
  reason: string | null;
}

function parseCancelArgs(args: string[]): { ok: true; opts: CancelArgs } | { ok: false; error: string } {
  const opts: CancelArgs = { confirm: false, reason: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--confirm') opts.confirm = true;
    else if (a === '--reason') opts.reason = args[++i] ?? null;
    else if (a === '--json') { /* handled globally */ }
    else return { ok: false, error: 'unknown argument "' + a + '". Usage: bot manual cancel-intent <intentId> [--confirm] [--reason <text>] [--json]' };
  }
  return { ok: true, opts };
}

// ---------------------------------------------------------------------------
// Proposal snapshot/valuation (read-only)
// ---------------------------------------------------------------------------

async function fetchManagedValuation(
  adapter: FeeCtx,
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
      // leave absent => risk fails closed (valuations unknown).
    }
  }
  return out;
}

async function buildContext(
  deps: ManualCliDeps,
  symbol: string,
  side: 'BUY' | 'SELL',
  reason: string,
  sellTargetCad: number | null,
): Promise<{ ctx: RiskContext } | { error: string }> {
  const policy = feePolicy(deps.cfg);
  let snapshot: LiveSnapshot;
  try {
    snapshot = await fetchLiveSnapshot({ adapter: deps.adapter, nowMs: deps.nowMs ?? Date.now, policy }, symbol);
  } catch (e) {
    return { error: 'exchange read failed while building the proposal: ' + (e instanceof Error ? e.message : String(e)) };
  }
  const valuation = await fetchManagedValuation(deps.adapter, deps.getPortfolio(), symbol, deps.nowMs ?? Date.now);
  const sellTarget = sellTargetCad !== null ? { notional: Money.fromNumber(sellTargetCad) } : null;
  const ctx = buildLiveRiskContext({
    snapshot,
    portfolio: deps.getPortfolio(),
    symbol,
    side,
    reason,
    sellTarget,
    managedValuation: valuation,
    freshnessPolicy: policy,
  });
  return { ctx };
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

function firstPositional(rest: string[]): string {
  const i = rest.findIndex((a) => !a.startsWith('--'));
  return i >= 0 ? rest[i]! : '';
}

function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : null;
}

async function cmdPropose(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const parsed = parseProposeArgs(args);
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const built = await buildContext(deps, o.symbol, o.side, o.reason, o.sellTargetCad);
  if ('error' in built) return failed([built.error], { error: built.error });

  const res = deps.bridge.propose(built.ctx, { reason: o.reason, limitPrice: o.limitPrice, sellTarget: o.sellTargetCad !== null ? { notional: Money.fromNumber(o.sellTargetCad) } : null });
  if (!res.ok) {
    return failed([
      'Risk decision: NOT APPROVED — ' + res.reason,
      'No intent was created and no exchange order was placed by RETRAC.',
    ], { error: 'risk_rejected', reason: res.reason, side: o.side, symbol: o.symbol });
  }
  const intent = res.intent;
  const lines = renderHeader(intent);
  lines.push(
    '',
    'Reservation:',
    '  currency:                 ' + (intent.reservationCurrency ?? 'n/a (SELL)'),
    '  amount:                   ' + (intent.reservationAmount ? intent.reservationAmount.toString() : 'n/a'),
    '',
    'RETRAC has NOT placed any exchange order. The operator must execute this intent EXTERNALLY.',
    'Run `bot manual confirm ' + intent.intentId + '` to approve this intent for external execution.',
  );
  const st = buildState(deps, intent);
  st['riskResult'] = { approved: true, quantity: intent.quantity.toString(), estimatedNotional: intent.riskSnapshot.estimatedNotional.toString(), appliedLimits: intent.riskSnapshot.appliedLimits };
  return ok(lines, st);
}

async function cmdShow(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual show <intentId> [--json]'], { error: 'missing_intent_id' });
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const pf = deps.getPortfolio();
  const s = pf.manualSettlement(intentId);
  const r = pf.orderReservation(intentId);
  const lines = renderHeader(intent);
  lines.push(
    '', 'Executed evidence:',
    '  orderId evidence:         ' + (intent.evidence?.orderId ?? 'none'),
    '  exchange order status:    ' + (intent.evidence?.status ?? 'n/a'),
    '  filled quantity:          ' + (intent.evidence?.filledQuantity ? intent.evidence.filledQuantity.toString() : 'n/a'),
    '  avg price:                ' + (intent.evidence?.averagePrice ? intent.evidence.averagePrice.toString() : 'n/a'),
    '  evidence source:          ' + (intent.evidence?.evidenceSource ?? 'n/a'),
    '', 'Accounting:',
    '  state:                    ' + intent.status,
    '  settlementMode:           ' + (s?.settlementMode ?? 'not accounted'),
    '  provenanceProof:          false (never exchange-proven)',
    '  exchangeValidated:        ' + (s ? (s.exchangedValidated ? 'true' : 'false') : 'not accounted'),
    '  operatorAttested:         ' + (s ? (s.settlementMode === 'operator_attested' ? 'true' : (s.exchangedValidated ? 'false' : 'unknown')) : 'unknown'),
  );
  const fee = feeOfIntent(intent, deps);
  lines.push('  fee:                      ' + fee.amount + ' (' + fee.status + ')');
  lines.push('  fee evidence:             ' + fee.evidence);
  lines.push('', 'Safety:');
  lines.push('  reservation:              ' + (r ? r.status + ' (' + r.currency + ' ' + r.remaining.toString() + ' remaining)' : 'none'));
  lines.push('  safeToTrade:              ' + 'run `bot manual reconcile` to determine');
  lines.push('  operator attestation:     ' + 'see above (never exchange-proven provenance)');
  if (intent.status === 'RECONCILIATION_REQUIRED') lines.push('', 'WARNING: accounting cannot be completed safely (see fee evidence). Intent remains RECONCILIATION_REQUIRED.');
  if (intent.status === 'AMBIGUOUS') lines.push('', 'WARNING: evidence is contradictory. Reservation is retained. Resolve before continuing.');
  return ok(lines, buildState(deps, intent));
}

async function cmdConfirm(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual confirm <intentId> [--operator <name>] [--json]'], { error: 'missing_intent_id' });
  const operator = flagValue(args, '--operator');
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  let confirmed: ManualTradeIntent;
  try {
    confirmed = deps.bridge.confirm(intentId, operator ?? undefined);
  } catch (e) {
    return blocked(['cannot confirm: ' + (e instanceof Error ? e.message : String(e))], { error: 'invalid_state_transition', intentId, state: intent.status });
  }
  const lines = renderHeader(confirmed);
  lines.push('', 'CONFIRMED for external/manual execution.', 'This does NOT mean the exchange order was placed. RETRAC has not placed anything.');
  return ok(lines, buildState(deps, confirmed));
}

async function cmdInstructions(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual instructions <intentId> [--json]'], { error: 'missing_intent_id' });
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const lines = renderHeader(intent);
  lines.push(
    '',
    'EXTERNAL EXECUTION INSTRUCTIONS (operator executes, RETRAC does NOT):',
    '  1. RETRAC will NOT place this order. You must execute it externally on the exchange.',
    '  2. Execute: ' + intent.side + ' ' + intent.quantity.toString() + ' ' + intent.symbol + ' as a ' + intent.type + ' order' + (intent.limitPrice ? ' at or better than ' + intent.limitPrice.toString() : ' (market)') + '.',
    '  3. PRESERVE the exchange OrderId returned by the exchange.',
    '  4. Return to RETRAC and run: bot manual evidence ' + intent.intentId + ' --order-id <OrderId>',
    '  5. Note: an OrderId is NOT proof of intent provenance. RETRAC performs read-only consistency checks only.',
    '  6. RETRAC will not fabricate an execution id and will not treat the OrderId as one.',
  );
  return ok(lines, buildState(deps, intent));
}

async function cmdEvidence(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual evidence <intentId> --order-id <X> [--json]'], { error: 'missing_intent_id' });
  const parsed = parseEvidenceArgs(args.filter((a) => a !== intentId));
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const input: RecordEvidenceInput = {
    orderId: o.orderId,
    status: o.status as RecordEvidenceInput['status'],
    filledQuantity: o.filledQuantity,
    averagePrice: o.averagePrice,
    fee: o.fee,
    feeCurrency: o.feeCurrency,
    evidenceSource: o.source,
    ...(o.note !== undefined ? { note: o.note } : {}),
  };
  let recorded: ManualTradeIntent;
  try {
    recorded = deps.bridge.recordEvidence(intentId, input);
  } catch (e) {
    return blocked(['cannot record evidence: ' + (e instanceof Error ? e.message : String(e))], { error: 'evidence_rejected', intentId, state: intent.status });
  }
  const lines = [
    'MANUAL EXECUTION BRIDGE (operator-executed)',
    '  intentId:                 ' + recorded.intentId,
    '  recorded orderId:         ' + o.orderId,
    '  evidence source:          ' + o.source,
    '  new state:                ' + recorded.status,
    '',
    'The external OrderId is recorded as EVIDENCE, NOT as provenance proof.',
    'Run `bot manual verify ' + intentId + '` for read-only exchange consistency validation.',
  ];
  return ok(lines, buildState(deps, recorded));
}

async function cmdVerify(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual verify <intentId> [--json]'], { error: 'missing_intent_id' });
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const orderId = intent.evidence?.orderId ?? null;
  const lines: string[] = ['MANUAL EXECUTION BRIDGE — READ-ONLY EXCHANGE VERIFICATION'];
  const json: Record<string, unknown> = { intentId, provenanceProof: false, provenance: 'NOT PROVEN', observedTradeEvidence: [] };

  if (!orderId) {
    lines.push('  no external OrderId recorded for this intent; run `bot manual evidence` first.');
    lines.push('  EXCHANGE VALIDATION: NOT APPLICABLE. PROVENANCE: NOT PROVEN.');
    json.exchangeValidation = { status: 'NO_ORDER_ID' };
    return blocked(lines, json);
  }

  let authoritative: Order;
  try {
    authoritative = await deps.adapter.getOrderStatus(intent.symbol, undefined, orderId);
  } catch (e) {
    lines.push('  exchange read failed: ' + (e instanceof Error ? e.message : String(e)));
    lines.push('  EXCHANGE VALIDATION: UNAVAILABLE. PROVENANCE: NOT PROVEN.');
    json.exchangeValidation = { status: 'READ_FAILED' };
    return blocked(lines, json);
  }

  const binding = bindOrderToIntent(intent, authoritative);
  const fee = classifyFee(authoritative.fee, authoritative.feeCurrency);
  lines.push('  orderId:                  ' + (authoritative.exchangeOrderId ?? 'n/a'),
    '  symbol:                    ' + authoritative.symbol + ' (intent ' + intent.symbol + ')',
    '  side:                      ' + authoritative.side + ' (intent ' + intent.side + ')',
    '  requested qty:             ' + authoritative.quantity.toString(),
    '  filled qty:                ' + authoritative.filledQuantity.toString(),
    '  status:                    ' + authoritative.status,
    '  fee:                       ' + fee.amount + ' (' + fee.status + ')',
    '  fee evidence:              ' + fee.evidence);
  if (binding.ok) {
    lines.push('  consistency basis:        ' + binding.basis.join(', '));
    lines.push('  EXCHANGE VALIDATION: CONSISTENT (order exists; symbol/side/qty/price/timing align).');
  } else {
    lines.push('  consistency:              FAILED — ' + (binding.reason ?? 'unknown'));
    lines.push('  EXCHANGE VALIDATION: NOT CONSISTENT.');
  }
  json.exchangeValidation = {
    status: binding.ok ? 'CONSISTENT' : 'INCONSISTENT',
    basis: binding.basis,
    provenanceProof: false,
    order: {
      orderId: authoritative.exchangeOrderId, symbol: authoritative.symbol, side: authoritative.side,
      requestedQuantity: authoritative.quantity.toString(), filledQuantity: authoritative.filledQuantity.toString(),
      status: authoritative.status, averagePrice: authoritative.averagePrice ? authoritative.averagePrice.toString() : null,
      fee: { amount: fee.amount, status: fee.status, currency: fee.currency },
    },
  };

  let trades: AccountTrade[] = [];
  try {
    trades = await deps.adapter.getAccountTrades(intent.symbol);
  } catch {
    trades = [];
  }
  const matching = trades.filter((t) => t.orderId === orderId);
  if (matching.length > 0) {
    lines.push('', 'Observed exchange trade evidence (read-only; NOT proven complete for this OrderId):');
    const tradeJson: Record<string, unknown>[] = [];
    for (const t of matching) {
      let resolved: ResolvedFee | undefined;
      if (deps.adapter.resolveFeeCurrency && t.feeProductId) {
        try { resolved = await deps.adapter.resolveFeeCurrency(t.feeProductId, intent.symbol); } catch { resolved = undefined; }
      }
      const tFee = classifyAccountTradeFee(t, resolved);
      lines.push('  executionId=' + (t.executionId ?? 'n/a') + ' tradeId=' + (t.tradeId ?? 'n/a') + ' qty=' + t.quantity.toString() + ' @ ' + t.price.toString() + ' fee=' + tFee.amount + ' (' + tFee.status + ')');
      tradeJson.push({ executionId: t.executionId, tradeId: t.tradeId, orderId: t.orderId, symbol: t.symbol, quantity: t.quantity.toString(), price: t.price.toString(), tradeTimeMs: t.tradeTimeMs, fee: { amount: t.fee.toString(), status: tFee.status, currency: tFee.currency, feeProductId: t.feeProductId, assetSymbol: tFee.assetSymbol } });
    }
    json.observedTradeEvidence = tradeJson;
    lines.push('  (this is NOT claimed to be a complete execution record for this OrderId.)');
  } else {
    lines.push('', 'No matching account trade evidence observed for this OrderId (read-only; may be a partial window).');
  }

  lines.push('', 'PROVENANCE: NOT PROVEN. Exchange consistency validated; intent-to-OrderId provenance remains operator-attested and is not exchange-proven.');
  json.provenance = 'NOT PROVEN';
  json.intentStatus = intent.status;
  return binding.ok ? ok(lines, json) : blocked(lines, json);
}

async function cmdSettle(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual settle <intentId> [--accounting-authority exchange|operator_attestation] [--confirm] [--operator <name>] [--json]'], { error: 'missing_intent_id' });
  const parsed = parseSettleArgs(args.filter((a) => a !== intentId));
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const confirmed = o.confirm ? true : (deps.confirm ? await deps.confirm('Account for this external execution [SETTLE]? ') : false);
  const out: SettleOutcome = await deps.bridge.settle(intentId, {
    confirmSettle: confirmed,
    accountingAuthority: o.authority,
    ...(o.operator ? { operator: o.operator } : {}),
  });
  return renderSettle(out, intent);
}

function renderSettle(out: SettleOutcome, intent: ManualTradeIntent): CliCommandResult {
  const lines: string[] = ['MANUAL EXECUTION BRIDGE — SETTLEMENT OUTCOME'];
  switch (out.outcome) {
    case 'ACCOUNTED_WITH_EXCHANGE_VALIDATION': {
      const s = out.settlement;
      lines.push('  state:                    ACCOUNTED_WITH_EXCHANGE_VALIDATION');
      lines.push('  accounting authority:     exchange');
      lines.push('  Accounting completed using exchange-authoritative evidence. Intent-to-order provenance is STILL NOT exchange-proven.');
      return ok(lines, { outcome: out.outcome, intentId: intent.intentId, state: intent.status, settlementMode: s.settlementMode, accountingAuthority: 'exchange', provenanceProof: s.provenanceProof, exchangeValidated: s.exchangedValidated, orderId: s.orderId, fee: s.fee.toString(), quantity: s.quantity.toString(), price: s.price.toString() });
    }
    case 'ACCOUNTED_WITH_OPERATOR_ATTESTATION': {
      const s = out.settlement;
      lines.push('  state:                    ACCOUNTED_WITH_OPERATOR_ATTESTATION');
      lines.push('  accounting authority:     operator_attestation');
      lines.push('  Accounting completed using operator attestation plus exchange consistency validation. Exchange provenance is NOT proven.');
      return ok(lines, { outcome: out.outcome, intentId: intent.intentId, state: intent.status, settlementMode: s.settlementMode, accountingAuthority: 'operator_attestation', provenanceProof: s.provenanceProof, exchangeValidated: s.exchangedValidated, orderId: s.orderId, fee: s.fee.toString(), quantity: s.quantity.toString(), price: s.price.toString() });
    }
    case 'RECONCILIATION_REQUIRED':
      lines.push('  state:                    RECONCILIATION_REQUIRED');
      lines.push('  Accounting cannot be completed safely because the fee currency/evidence is not authoritative. Intent remains RECONCILIATION_REQUIRED. No accounting was applied; the reservation is retained.');
      return blocked(lines, { outcome: out.outcome, intentId: intent.intentId, reason: out.reason });
    case 'PENDING':
      lines.push('  state:                    PENDING');
      lines.push('  The external order is not yet terminal (may still fill). No accounting applied; reservation retained.');
      return blocked(lines, { outcome: out.outcome, intentId: intent.intentId, reason: out.reason });
    case 'AMBIGUOUS':
      lines.push('  state:                    AMBIGUOUS');
      lines.push('  Evidence is contradictory. No accounting applied; reservation retained.');
      return blocked(lines, { outcome: out.outcome, intentId: intent.intentId, reason: out.reason });
    case 'CANCELED_TERMINAL_NO_FILL':
      lines.push('  state:                    CANCELED (terminal no-fill)');
      lines.push('  The external order reached a terminal state with no fill. The reservation was released exactly once. No accounting applied.');
      return ok(lines, { outcome: out.outcome, intentId: intent.intentId, reason: out.reason });
    case 'REFUSED':
      lines.push('  REFUSED: ' + out.reason);
      return failed(lines, { outcome: out.outcome, intentId: intent.intentId, reason: out.reason });
  }
}

async function cmdReconcile(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args) || null;
  const report = deps.bridge.reconcile();
  const lines: string[] = ['MANUAL EXECUTION BRIDGE — RECONCILIATION'];
  lines.push('  Safe to trade:            ' + (report.safeToTrade ? 'YES' : 'NO'));
  lines.push('  Total issues:             ' + report.issues.length + (report.fixesApplied.length ? ' (fixed ' + report.fixesApplied.length + ')' : ''));
  if (intentId) {
    const intent = deps.bridge.get(intentId);
    if (!intent) return intentNotFound(intentId);
    lines.push('  Intent state:             ' + intent.status);
    lines.push('  Reservation:              ' + (deps.getPortfolio().orderReservation(intentId)?.status ?? 'none'));
    lines.push('  Evidence status:          ' + (intent.evidence ? 'recorded (source=' + intent.evidence.evidenceSource + ')' : 'not recorded'));
  }
  for (const issue of report.issues) {
    lines.push('  [' + issue.severity.toUpperCase() + '] ' + issue.type + (issue.fixed ? ' (FIXED)' : '') + ': ' + issue.detail);
  }
  lines.push('', 'Reconciliation never fabricates a fill, never invents an executionId, never infers a fee currency, and never converts AMBIGUOUS/RECONCILIATION_REQUIRED into success automatically.');
  if (!report.safeToTrade) lines.push('', 'RECOMMENDED NEXT ACTION: resolve the error-level issues above before accounting/trading continues. While safeToTrade=false, do not proceed.');
  const json: Record<string, unknown> = { safeToTrade: report.safeToTrade, issues: report.issues.map((i) => ({ type: i.type, severity: i.severity, fixed: i.fixed, intentId: i.intentId, detail: i.detail })) };
  if (intentId) json['intent'] = buildState(deps, deps.bridge.get(intentId)!);
  return report.safeToTrade ? ok(lines, json) : blocked(lines, json);
}

async function cmdCancelIntent(deps: ManualCliDeps, args: string[]): Promise<CliCommandResult> {
  const intentId = firstPositional(args);
  if (!intentId) return failed(['usage: bot manual cancel-intent <intentId> [--confirm] [--reason <text>] [--json]'], { error: 'missing_intent_id' });
  const parsed = parseCancelArgs(args.filter((a) => a !== intentId));
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const intent = deps.bridge.get(intentId);
  if (!intent) return intentNotFound(intentId);
  const confirmed = o.confirm ? true : (deps.confirm ? await deps.confirm('Cancel this LOCALLY held manual intent (does NOT cancel any exchange order) [CANCEL]? ') : false);
  let canceled: ManualTradeIntent;
  try {
    canceled = deps.bridge.cancel(intentId, { confirmCancel: confirmed, ...(o.reason ? { reason: o.reason } : {}) });
  } catch (e) {
    return blocked(['cannot cancel-intent: ' + (e instanceof Error ? e.message : String(e)), 'This cancels ONLY the local manual intent and NEVER cancels an exchange order.'], { error: 'cancel_refused', intentId, state: intent.status });
  }
  const lines = renderHeader(canceled);
  lines.push('', 'CANCEL INTENT (LOCAL ONLY):', '  This cancels ONLY the RETRAC local manual intent. It does NOT cancel any exchange order.', '  Reservation (if any) released exactly once, matching the existing zero-fill path.');
  return ok(lines, buildState(deps, canceled));
}

async function cmdReservations(deps: ManualCliDeps): Promise<CliCommandResult> {
  const pf = deps.getPortfolio();
  const lines: string[] = ['MANUAL EXECUTION BRIDGE — ACTIVE RESERVATIONS'];
  const json: Record<string, unknown> = { reservations: [] as Record<string, unknown>[] };
  let n = 0;
  for (const [id, r] of pf.orderReservationsView()) {
    n += 1;
    lines.push('  ' + id + '  ' + r.currency + ' ' + r.remaining.toString() + ' remaining of ' + r.amount.toString() + ' [' + r.status + ']');
    (json.reservations as Record<string, unknown>[]).push({ intentId: id, currency: r.currency, status: r.status, amount: r.amount.toString(), remaining: r.remaining.toString() });
  }
  if (n === 0) lines.push('  (none)');
  return ok(lines, json);
}

async function cmdList(deps: ManualCliDeps): Promise<CliCommandResult> {
  const intents = deps.bridge.list();
  const lines: string[] = ['MANUAL EXECUTION BRIDGE — INTENTS'];
  const json: Record<string, unknown> = { intents: [] as Record<string, unknown>[] };
  if (intents.length === 0) lines.push('  (none)');
  for (const i of intents) {
    lines.push('  ' + i.intentId + '  ' + i.side + ' ' + i.quantity.toString() + ' ' + i.symbol + '  [' + i.status + ']  orderId=' + (i.evidence?.orderId ?? 'n/a'));
    (json.intents as Record<string, unknown>[]).push(buildState(deps, i));
  }
  return ok(lines, json);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runManualCommand(deps: ManualCliDeps, argv: string[]): Promise<CliCommandResult> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'propose': return await cmdPropose(deps, rest);
      case 'show': return await cmdShow(deps, rest);
      case 'confirm': return await cmdConfirm(deps, rest);
      case 'instructions': return await cmdInstructions(deps, rest);
      case 'evidence': return await cmdEvidence(deps, rest);
      case 'verify': return await cmdVerify(deps, rest);
      case 'settle': return await cmdSettle(deps, rest);
      case 'reconcile': return await cmdReconcile(deps, rest);
      case 'cancel-intent': return await cmdCancelIntent(deps, rest);
      case 'reservations': return await cmdReservations(deps);
      case 'list': return await cmdList(deps);
      default:
        return failed(['unknown manual sub-command: "' + sub + '"\n' + MANUAL_USAGE], { error: 'unknown_subcommand', sub });
    }
  } catch (e) {
    // Fail-closed: any thrown error (corrupt store, unexpected exception) is never a success.
    const message = e instanceof Error ? e.message : String(e);
    return failed(['error: ' + message], { error: 'command_failed', message });
  }
}

const MANUAL_USAGE =
  'bot manual — CONSTRAINED MANUAL EXECUTION BRIDGE (operator interface)\n' +
  '\n' +
  'This is NOT a trading terminal and NOT an order-placement interface. RETRAC never\n' +
  'places, cancels, or modifies any exchange order through "bot manual".\n' +
  '\n' +
  'Sub-commands:\n' +
  '  propose       [--symbol SYM] [--side BUY|SELL] [--reason text] [--limit-price X] [--sell-target-cad N]\n' +
  '  show          <intentId>\n' +
  '  confirm       <intentId> [--operator name]\n' +
  '  instructions  <intentId>\n' +
  '  evidence      <intentId> --order-id <X> [--status ST] [--filled-qty Q] [--avg-price P] [--fee F] [--fee-currency base|quote] [--source S]\n' +
  '  verify        <intentId>\n' +
  '  settle        <intentId> [--accounting-authority exchange|operator_attestation] [--confirm] [--operator name]\n' +
  '  reconcile     [intentId]\n' +
  '  cancel-intent <intentId> [--confirm] [--reason text]\n' +
  '  reservations\n' +
  '  list\n' +
  '\n' +
  'All sub-commands accept --json for a stable structured result.\n' +
  'Exit codes: 0 = completed safely; 2 = blocked/fail-closed (reconciliation-required,\n' +
  'ambiguous, pending, not safe-to-trade, refused); 1 = error.\n';

export function printManualUsage(): void {
  // eslint-disable-next-line no-console
  console.log(MANUAL_USAGE);
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // eslint-disable-next-line no-console
    console.error('stdin is not a TTY; cannot confirm interactively. Pass the explicit confirmation flag instead. Refusing to continue.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return answer.trim().toUpperCase() === 'SETTLE' || answer.trim().toUpperCase() === 'CANCEL';
}

export const manualCommand: CommandHandler = async (args): Promise<number> => {
  let cfg: BotConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  if (!cfg.enableAuthenticatedReads) {
    // eslint-disable-next-line no-console
    console.error('The manual bridge needs authenticated account reads, but NDAX_ENABLE_AUTHENTICATED_READS is not "true".');
    return 2;
  }

  const credentials: Record<string, string> = { apiKey: cfg.ndaxApiKey, apiSecret: cfg.ndaxApiSecret, userId: cfg.ndaxUserId, userName: cfg.ndaxUserName };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  let adapter: ExchangeAdapter;
  try {
    adapter = createExchange(cfg.exchange, { credentials, config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Could not construct the exchange adapter:\n' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }

  const liveStore = new ManagedStateStore(cfg.liveManagedStateFile);
  let managed: Portfolio;
  try {
    // Fail-closed live/manual realm startup: corruption, unexpected state loss,
    // and cross-file contradictions (orphan reservations, accounted intents
    // without a settlement) are all rejected before the bridge may operate.
    assertLiveRealmRecoverable(cfg);
    managed = loadLiveManagedPortfolio(cfg);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Live managed state is not safe to operate on: ' + (e instanceof Error ? e.message : String(e)) + '\nRefusing to proceed (operator intervention / `bot reconcile` required).');
    return 1;
  }
  const riskManager = buildRiskManager(cfg);

  const readOnly = toReadOnlyAdapter(adapter);
  const bridge = new ManualTradeBridge({
    intentStore: new ManualIntentStore(cfg.manualIntentFile),
    getPortfolio: () => managed,
    savePortfolio: (p) => { managed = p; liveStore.save(p.stateModel); },
    riskManager,
    adapter: readOnly,
    nowMs: () => Date.now(),
    operator: 'manual-cli',
  });

  const result = await runManualCommand({
    cfg,
    adapter: readOnly,
    bridge,
    getPortfolio: () => managed,
    riskManager,
    nowMs: () => Date.now(),
    confirm: defaultConfirm,
  }, args);

  if (args.includes('--json')) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result.json));
  } else {
    for (const l of result.lines) {
      // eslint-disable-next-line no-console
      console.log(l);
    }
  }
  return result.code;
};
