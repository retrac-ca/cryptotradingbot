/**
 * `bot resolve-live-order` — operator-attested resolution of an ambiguous
 * controlled-live order.
 *
 * This is the operator-only resolution path for a RETRAC-SUBMITTED live order
 * that is exchange-FILLED but whose execution set cannot be proven complete
 * (execution correlation UNKNOWN/UNCORRELATED, completeness UNKNOWN, local
 * reconciliation RECONCILIATION_REQUIRED).
 *
 * SAFETY CONTRACT (enforced structurally + by convention):
 *   - The exchange adapter is wrapped in a read-only proxy; no code path here
 *     can reach `placeOrder`/`cancelOrder`. It NEVER submits, cancels, retries,
 *     or creates an exchange order.
 *   - The operator CANNOT enter arbitrary financial data. The attested numbers
 *     come ONLY from a fresh READ-ONLY exchange read (`evidenceSource =
 *     'exchange_read'`); the original symbol/side/type/quantity/limit price come
 *     from the persisted live order.
 *   - Operator attestation is NEVER exchange proof: `provenanceProof` is always
 *     `false` and `accountingAuthority` is always `operator_attestation`. The
 *     command explicitly communicates that execution completeness could not be
 *     proven before confirmation.
 *   - Fees are NEVER silently assumed. A fee is accepted only when it is zero
 *     (currency-agnostic) OR authoritatively quote/CAD. A non-zero
 *     base/third/unknown fee fails closed (the order is NOT resolved).
 *   - Only the attributable proceeds (filled quantity x average execution price -
 *     fee) are booked; the residual exchange balance (e.g. the observed CAD
 *     residual) is NEVER adopted as order proceeds, and unrelated external
 *     inventory is never touched.
 *   - All mutation happens under the state-directory mutation lock with a TOCTOU
 *     reload + revalidation; any mismatch aborts before any partial mutation.
 *
 * Exit codes (existing CLI convention):
 *   0 = completed safely / idempotent no-op
 *   2 = blocked / fail-closed (not confirmed, evidence mismatch, fee unresolved,
 *       not resolved, TOCTOU abort)
 *   1 = error (config, order not found, corrupt store, exchange read failure)
 */

import { createInterface } from 'node:readline';
import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { ResourceNotFoundError } from '../exchanges/errors.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import { Money } from '../money/Money.js';
import type { Order } from '../order.js';
import type { AccountTrade, Balance } from '../types.js';
import type { ExchangeEvidenceSnapshot, AccountTradeEvidence, BalanceEvidence } from '../portfolio/types.js';
import { OrderStore, ManagedStateStore, withStateDirLock, CorruptStateError } from '../persistence/index.js';
import { toReadOnlyAdapter, type FeeCtx, type ResolvedFee } from './manual-cmd.js';
import type { CommandHandler } from './context.js';

interface CliCommandResult {
  code: number;
  lines: string[];
  json: Record<string, unknown>;
}

const ok = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 0, lines, json });
const blocked = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 2, lines, json });
const failed = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 1, lines, json });

interface ResolveLiveOrderArgs {
  clientOrderId: string;
  orderId: string;
  operator: string;
  accountingAuthority: string;
  confirm: boolean;
}

function parseResolveLiveOrderArgs(args: string[]): { ok: true; opts: ResolveLiveOrderArgs } | { ok: false; error: string } {
  const opts: ResolveLiveOrderArgs = {
    clientOrderId: '',
    orderId: '',
    operator: '',
    accountingAuthority: '',
    confirm: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--order-id') { const v = args[++i]; if (!v) return { ok: false, error: '--order-id requires a value' }; opts.orderId = v; }
    else if (a === '--operator') { const v = args[++i]; if (!v) return { ok: false, error: '--operator requires a value' }; opts.operator = v; }
    else if (a === '--accounting-authority') { const v = args[++i]; if (!v) return { ok: false, error: '--accounting-authority requires a value' }; opts.accountingAuthority = v; }
    else if (a === '--confirm') { opts.confirm = true; }
    else if (a === '--json') { /* handled globally */ }
    else if (a.startsWith('--')) return { ok: false, error: `unknown argument "${a}". Usage: bot resolve-live-order <clientOrderId> --order-id <exchangeOrderId> --operator <name> --accounting-authority operator_attestation [--confirm] [--json]` };
    else if (!opts.clientOrderId) { opts.clientOrderId = a; }
    else return { ok: false, error: `unexpected positional argument "${a}". Usage: bot resolve-live-order <clientOrderId> --order-id <exchangeOrderId> --operator <name> --accounting-authority operator_attestation [--confirm] [--json]` };
  }
  if (!opts.clientOrderId) return { ok: false, error: 'clientOrderId is required (the exact local live order id)' };
  if (!opts.orderId) return { ok: false, error: '--order-id is required (the exact exchange OrderId)' };
  if (!opts.operator) return { ok: false, error: '--operator is required (operator identity for the audit trail)' };
  if (opts.accountingAuthority !== 'operator_attestation') {
    return { ok: false, error: '--accounting-authority must be exactly "operator_attestation"' };
  }
  return { ok: true, opts };
}

/** Dependencies for the testable resolve-live-order core (adapter is already read-only). */
export interface ResolveLiveOrderDeps {
  cfg: { stateDir: string };
  adapter: FeeCtx;
  orders: OrderStore;
  live: ManagedStateStore;
  nowMs?: () => number;
  confirm?: (message: string) => Promise<boolean>;
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
  return answer.trim().toUpperCase() === 'RESOLVE';
}

/**
 * Resolve the fee for the attestation.
 *
 * PRECEDENCE (authoritative correlated trade fee wins over order-level fee):
 *  1. If there is EXACTLY ONE exact correlated AccountTrade (matching exchange
 *     OrderId + symbol + side, with a valid execution id and non-negative
 *     fee/positive quantity/price), use that trade as the fee authority:
 *       - a zero fee                 => fee 0 (quote).
 *       - a non-zero fee whose feeProductId resolves authoritatively to the
 *         instrument quote currency => use that exact fee amount (quote).
 *       - a non-zero base/third/unknown fee => FAIL CLOSED.
 *  2. If there are MULTIPLE correlated trades, FAIL CLOSED: without proven
 *     enumeration we cannot know whether we have all fees (never arbitrarily
 *     collapse or pick one).
 *  3. If NO correlated trade exists, fall back to the order-level fee:
 *       - a zero fee (0 amount is currency-agnostic) => fee 0.
 *       - a non-zero fee with authoritative quote currency => order fee.
 *       - otherwise => FAIL CLOSED (never assume/convert an unknown fee).
 *
 * This prevents an order-level 0/unknown fee from overriding a real, exact
 * correlated execution fee (the NDAX case for this order).
 */
async function resolveAttestationFee(
  adapter: FeeCtx,
  authoritative: Order,
  accountTrades: AccountTrade[],
  targetQuantity: Money,
): Promise<{ ok: true; fee: Money; feeCurrency: 'quote'; evidence: string } | { ok: false; reason: string }> {
  const orderId = authoritative.exchangeOrderId;

  // Exact correlated executions: same exchange OrderId + symbol + side, with a
  // valid execution id and structurally valid economics.
  const correlated = accountTrades.filter(
    (t) =>
      t.orderId != null &&
      orderId != null &&
      Portfolio.sameExternalOrderId(t.orderId, orderId) &&
      t.symbol === authoritative.symbol &&
      t.side === authoritative.side &&
      t.executionId != null &&
      !t.fee.isNegative() &&
      t.quantity.isPositive() &&
      t.price.isPositive(),
  );

  if (correlated.length === 1) {
    const t = correlated[0]!;
    // The single execution must account for the full attested fill quantity;
    // otherwise it is not the complete execution of this order.
    if (!t.quantity.equals(targetQuantity)) {
      return { ok: false, reason: 'single correlated execution quantity does not match the attested fill quantity; cannot attest' };
    }
    if (t.fee.isZero()) {
      return { ok: true, fee: Money.zero(), feeCurrency: 'quote', evidence: 'exact correlated execution reports a zero fee' };
    }
    let resolved: ResolvedFee | undefined;
    if (t.feeProductId && adapter.resolveFeeCurrency) {
      try {
        resolved = await adapter.resolveFeeCurrency(t.feeProductId, authoritative.symbol);
      } catch {
        resolved = undefined;
      }
    }
    if (resolved && resolved.kind === 'quote') {
      return { ok: true, fee: t.fee, feeCurrency: 'quote', evidence: `exact correlated execution fee (feeProductId ${t.feeProductId} -> ${resolved.assetSymbol ?? 'quote'})` };
    }
    return { ok: false, reason: 'correlated execution has a non-zero fee that is not authoritatively quote (base/third/unknown); cannot attest (never assume a fee)' };
  }

  if (correlated.length > 1) {
    return { ok: false, reason: 'multiple correlated executions; cannot derive a single authoritative fee without proven enumeration (fail closed)' };
  }

  // No correlated execution: order-level fee fallback.
  const fee = authoritative.fee;
  if (fee.isNegative()) {
    return { ok: false, reason: 'exchange reported a negative fee; cannot attest' };
  }
  if (fee.isZero()) {
    return { ok: true, fee: Money.zero(), feeCurrency: 'quote', evidence: 'exchange reported a zero fee' };
  }
  if (authoritative.feeCurrency === 'quote') {
    return { ok: true, fee, feeCurrency: 'quote', evidence: 'authoritative order fee currency is quote' };
  }
  return { ok: false, reason: 'non-zero fee with no authoritative quote/CAD evidence; cannot attest (never assume a fee)' };
}

function buildEvidenceSnapshot(
  authoritative: Order,
  orderEvidenceSource: 'status' | 'history',
  accountTrades: AccountTrade[],
  balances: Balance[],
  readAtMs: number,
): ExchangeEvidenceSnapshot {
  return {
    orderId: authoritative.exchangeOrderId ?? '',
    symbol: authoritative.symbol,
    side: authoritative.side,
    type: authoritative.type,
    status: authoritative.status,
    quantity: authoritative.quantity,
    filledQuantity: authoritative.filledQuantity,
    averagePrice: authoritative.averagePrice,
    limitPrice: authoritative.price,
    fee: authoritative.fee,
    feeCurrency: authoritative.feeCurrency,
    reason: authoritative.reason,
    createdAtMs: authoritative.createdAtMs,
    updatedAtMs: authoritative.updatedAtMs,
    orderEvidenceSource,
    observedAccountTrades: accountTrades.map<AccountTradeEvidence>((t) => ({
      executionId: t.executionId,
      tradeId: t.tradeId,
      orderId: t.orderId,
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      fee: t.fee,
      feeProductId: t.feeProductId,
      tradeTimeMs: t.tradeTimeMs,
    })),
    observedBalances: balances.map<BalanceEvidence>((b) => ({
      currency: b.currency,
      total: b.total,
      available: b.available,
      held: b.held,
    })),
    readAtMs,
  };
}

/**
 * Fetch the authoritative terminal order evidence. First tries `GetOrderStatus`.
 * If and only if `GetOrderStatus` throws a NOT-FOUND condition, fall back to
 * `GetOrderHistory` and locate the exact order by exchange OrderId. Any other
 * error is propagated (never swallowed) so the command fails closed. The source
 * of the order evidence is returned so the attestation audit can distinguish a
 * live status read from a historical read.
 */
async function fetchAuthoritativeOrder(adapter: FeeCtx, localOrder: Order): Promise<{ order: Order; source: 'status' | 'history' }> {
  try {
    const status = await adapter.getOrderStatus(localOrder.symbol, localOrder.clientOrderId, localOrder.exchangeOrderId ?? undefined);
    return { order: status, source: 'status' };
  } catch (err) {
    if (!(err instanceof ResourceNotFoundError)) {
      throw err; // only the known not-found condition may trigger the fallback
    }
    const history = await adapter.getOrderHistory();
    const found = history.find(
      (h) => h.exchangeOrderId != null && localOrder.exchangeOrderId != null && Portfolio.sameExternalOrderId(h.exchangeOrderId, localOrder.exchangeOrderId),
    );
    if (!found) {
      throw new Error(`order ${localOrder.exchangeOrderId} not found in GetOrderStatus nor GetOrderHistory`);
    }
    return { order: found, source: 'history' };
  }
}

function renderEvidence(
  order: Order,
  authoritative: Order,
  orderEvidenceSource: 'status' | 'history',
  accountTrades: AccountTrade[],
  fee: { fee: Money; feeCurrency: 'quote'; evidence: string },
  balances: Balance[],
): string[] {
  const lines: string[] = [
    'RESOLVE LIVE ORDER — OPERATOR ATTESTATION (NOT exchange-proven)',
    '  clientOrderId:            ' + order.clientOrderId,
    '  exchange OrderId:         ' + (authoritative.exchangeOrderId ?? 'n/a'),
    '  evidence source:          ' + (orderEvidenceSource === 'status' ? 'GetOrderStatus' : 'GetOrderHistory (fallback)'),
    '  symbol / side / type:     ' + authoritative.symbol + ' ' + authoritative.side + ' ' + authoritative.type,
    '  original quantity:        ' + order.quantity.toString(),
    '  original limit price:     ' + (order.price ? order.price.toString() : '(n/a)'),
    '  exchange status:          ' + authoritative.status,
    '  exchange filled qty:      ' + authoritative.filledQuantity.toString(),
    '  exchange avg exec price:  ' + (authoritative.averagePrice ? authoritative.averagePrice.toString() : 'n/a'),
    '  fee:                      ' + fee.fee.toString() + ' (' + fee.feeCurrency + ')  [' + fee.evidence + ']',
    '',
    '  Observed account trades (read-only, NOT proven complete):',
  ];
  if (accountTrades.length === 0) {
    lines.push('    (none observed)');
  } else {
    for (const t of accountTrades) {
      lines.push('    executionId=' + (t.executionId ?? 'n/a') + ' orderId=' + (t.orderId ?? 'n/a') + ' qty=' + t.quantity.toString() + ' @ ' + t.price.toString() + ' fee=' + t.fee.toString() + ' feeProductId=' + (t.feeProductId ?? 'n/a'));
    }
  }
  lines.push('', '  Observed balances (read-only):');
  for (const b of balances) {
    lines.push('    ' + b.currency + ' total=' + b.total.toString() + ' available=' + b.available.toString() + ' held=' + b.held.toString());
  }
  lines.push(
    '',
    'WARNING: execution completeness is NOT proven (correlation UNKNOWN/UNCORRELATED).',
    'This is OPERATOR ATTESTATION. provenanceProof=false, accountingAuthority=operator_attestation.',
    'The attested numbers come from the fresh exchange read (evidenceSource=exchange_read).',
    'Only the attributable proceeds (filled qty x avg price - fee) will be booked.',
    'The residual exchange balance is NOT adopted as order proceeds; unrelated external inventory is untouched.',
  );
  return lines;
}

/**
 * Cross-check the fresh exchange order against the existing local live order's
 * identity. Returns a short label for the first mismatch, or null when the
 * exchange order is unambiguously the SAME logical order as the local one.
 *
 * This does NOT rely solely on exchange OrderId uniqueness: the operator must
 * not be able to resolve an order if the fresh exchange evidence identifies a
 * different symbol, side, type, requested quantity, or applicable limit price.
 */
function exchangeIdentityMismatch(exchangeOrder: Order, localOrder: Order): string | null {
  if (exchangeOrder.exchangeOrderId == null || !Portfolio.sameExternalOrderId(exchangeOrder.exchangeOrderId, localOrder.exchangeOrderId)) {
    return 'exchangeOrderId';
  }
  if (exchangeOrder.symbol !== localOrder.symbol) return 'symbol';
  if (exchangeOrder.side !== localOrder.side) return 'side';
  if (exchangeOrder.type !== localOrder.type) return 'type';
  if (!exchangeOrder.quantity.equals(localOrder.quantity)) return 'quantity';
  // For a LIMIT order, the exchange order must carry the SAME limit price. A
  // missing exchange limit price for a limit order is a mismatch, never a guess.
  if (localOrder.price != null) {
    if (exchangeOrder.price == null || !exchangeOrder.price.equals(localOrder.price)) return 'limit price';
  }
  return null;
}

/**
 * Resolve an ambiguous controlled-live order via operator attestation.
 *
 * Split out from the CLI handler so it can be tested against a FakeExchange with
 * injected deps (no network, no TTY). NEVER submits/cancels/retries; the
 * exchange adapter is already read-only.
 */
export async function runResolveLiveOrder(deps: ResolveLiveOrderDeps, argv: string[]): Promise<CliCommandResult> {
  const parsed = parseResolveLiveOrderArgs(argv);
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const now = deps.nowMs ?? Date.now;

  // The persisted live order must exist and already carry the exact exchange OrderId.
  const order = deps.orders.get(o.clientOrderId);
  if (!order) return failed([`live order ${o.clientOrderId} not found in the order ledger`], { error: 'order_not_found', clientOrderId: o.clientOrderId });
  if (order.exchangeOrderId == null || !Portfolio.sameExternalOrderId(order.exchangeOrderId, o.orderId)) {
    return failed(
      [`exchange order ${o.orderId} does not match the persisted order ${o.clientOrderId} (persisted exchangeOrderId=${order.exchangeOrderId ?? 'null'})`],
      { error: 'order_id_mismatch', clientOrderId: o.clientOrderId },
    );
  }

  // 1. Fresh READ-ONLY exchange evidence, immediately before confirmation.
  let authoritativeEvidence: { order: Order; source: 'status' | 'history' };
  let accountTrades: AccountTrade[] = [];
  let balances: Balance[] = [];
  try {
    authoritativeEvidence = await fetchAuthoritativeOrder(deps.adapter, order);
    accountTrades = await deps.adapter.getAccountTrades(order.symbol);
    balances = await deps.adapter.getBalances();
  } catch (err) {
    return blocked(
      [`fresh exchange read failed (${err instanceof Error ? err.message : String(err)}); fail closed, no accounting applied`],
      { error: 'exchange_read_failed', clientOrderId: o.clientOrderId },
    );
  }
  const authoritative = authoritativeEvidence.order;
  const orderEvidenceSource = authoritativeEvidence.source;

  // 2. Validate the exchange evidence.
  if (authoritative.exchangeOrderId == null || !Portfolio.sameExternalOrderId(authoritative.exchangeOrderId, o.orderId)) {
    return blocked([`exchange order ${o.orderId} not found / does not match; fail closed`], { error: 'exchange_order_id_mismatch', clientOrderId: o.clientOrderId });
  }
  const identityIssue = exchangeIdentityMismatch(authoritative, order);
  if (identityIssue) {
    return blocked([`exchange evidence identity mismatch (${identityIssue}); fail closed`], { error: 'exchange_identity_mismatch', clientOrderId: o.clientOrderId });
  }
  if (authoritative.status !== 'FILLED') {
    return blocked([`exchange order ${o.orderId} status is ${authoritative.status}, expected FILLED; fail closed`], { error: 'not_filled', clientOrderId: o.clientOrderId });
  }
  if (!authoritative.filledQuantity.equals(order.quantity)) {
    return blocked(
      [`exchange filledQuantity ${authoritative.filledQuantity} != original order quantity ${order.quantity}; fail closed`],
      { error: 'quantity_mismatch', clientOrderId: o.clientOrderId },
    );
  }
  if (!authoritative.averagePrice || !authoritative.averagePrice.isPositive()) {
    return blocked([`exchange order has no positive average execution price; fail closed`], { error: 'no_avg_price', clientOrderId: o.clientOrderId });
  }
  const feeRes = await resolveAttestationFee(deps.adapter, authoritative, accountTrades, authoritative.filledQuantity);
  if (!feeRes.ok) {
    return blocked([feeRes.reason], { error: 'fee_unresolved', clientOrderId: o.clientOrderId });
  }

  // 3. Display evidence + the operator-attestation warning, then confirm.
  const lines = renderEvidence(order, authoritative, orderEvidenceSource, accountTrades, feeRes, balances);
  const message = `\nAttest live order ${o.clientOrderId} (exchange order ${o.orderId}) as FILLED (operator attestation, provenanceProof=false)? Type RESOLVE to confirm: `;
  const confirmed = o.confirm ? true : (deps.confirm ? await deps.confirm(message) : await defaultConfirm(message));
  if (!confirmed) {
    return blocked([...lines, '', 'Not confirmed. No accounting applied.'], { error: 'not_confirmed', clientOrderId: o.clientOrderId });
  }

  // 4. Re-fetch fresh READ-ONLY exchange evidence AFTER confirmation (TOCTOU
  //    protection): the attestation uses the most recent evidence, and any change
  //    in the exchange state between the pre-confirmation read and now is caught
  //    before any accounting is applied.
  let freshEvidence: { order: Order; source: 'status' | 'history' };
  try {
    freshEvidence = await fetchAuthoritativeOrder(deps.adapter, order);
  } catch (err) {
    return blocked(
      [`fresh exchange evidence re-read failed (${err instanceof Error ? err.message : String(err)}); fail closed, no accounting applied`],
      { error: 'exchange_read_failed', clientOrderId: o.clientOrderId },
    );
  }
  const fresh = freshEvidence.order;
  const freshSource = freshEvidence.source;
  if (fresh.exchangeOrderId == null || !Portfolio.sameExternalOrderId(fresh.exchangeOrderId, o.orderId)) {
    return blocked([`exchange evidence mismatch: order ${o.orderId} is no longer the same exchange order`], { error: 'exchange_order_id_mismatch', clientOrderId: o.clientOrderId });
  }
  const freshIdentityIssue = exchangeIdentityMismatch(fresh, order);
  if (freshIdentityIssue) {
    return blocked([`exchange evidence identity mismatch (${freshIdentityIssue}); fail closed`], { error: 'exchange_identity_mismatch', clientOrderId: o.clientOrderId });
  }
  if (fresh.status !== 'FILLED') {
    return blocked([`exchange evidence mismatch: order ${o.orderId} status is now ${fresh.status}, expected FILLED`], { error: 'not_filled', clientOrderId: o.clientOrderId });
  }
  if (!fresh.filledQuantity.equals(order.quantity)) {
    return blocked([`exchange evidence mismatch: order ${o.orderId} filledQuantity is now ${fresh.filledQuantity}`], { error: 'quantity_mismatch', clientOrderId: o.clientOrderId });
  }
  if (!fresh.averagePrice || !fresh.averagePrice.isPositive()) {
    return blocked([`exchange evidence mismatch: order ${o.orderId} has no positive average execution price`], { error: 'no_avg_price', clientOrderId: o.clientOrderId });
  }
  const feeRes2 = await resolveAttestationFee(deps.adapter, fresh, accountTrades, fresh.filledQuantity);
  if (!feeRes2.ok) {
    return blocked([feeRes2.reason], { error: 'fee_unresolved', clientOrderId: o.clientOrderId });
  }
  const exchangeReadAtMs = now();
  const evidence = buildEvidenceSnapshot(fresh, freshSource, accountTrades, balances, exchangeReadAtMs);

  // 5. Acquire the state mutation lock, reload + revalidate (TOCTOU), then apply
  //    exactly once and atomically persist. SYNCHRONOUS ONLY: all exchange reads
  //    happen outside the lock (the mutation lock is never held across I/O).
  try {
    const applied = withStateDirLock(deps.cfg.stateDir, () => {
      // Reload the order from disk.
      const current = deps.orders.get(o.clientOrderId);
      if (!current) throw new Error(`order ${o.clientOrderId} no longer exists`);
      // Original identity must be unchanged.
      if (current.exchangeOrderId == null || !Portfolio.sameExternalOrderId(current.exchangeOrderId, o.orderId)) {
        throw new Error(`order ${o.clientOrderId} exchangeOrderId changed during resolution`);
      }
      if (current.symbol !== order.symbol || current.side !== order.side || current.type !== order.type) {
        throw new Error(`order ${o.clientOrderId} symbol/side/type changed during resolution`);
      }
      if (!current.quantity.equals(order.quantity)) throw new Error(`order ${o.clientOrderId} quantity changed during resolution`);
      if ((current.price ?? null)?.toString() !== (order.price ?? null)?.toString()) {
        throw new Error(`order ${o.clientOrderId} limit price changed during resolution`);
      }

      const liveR = deps.live.load();
      if (liveR.status === 'CORRUPT') {
        throw new CorruptStateError(`live managed state corrupt: ${liveR.reason}`);
      }
      let portfolio = liveR.status === 'OK' ? deps.live.toPortfolio(liveR.data) ?? Portfolio.empty(new Map()) : Portfolio.empty(new Map());
      const existingAttestation = portfolio.liveOrderAttestation(o.clientOrderId);

      // A terminal-but-not-yet-attested order (e.g. LiveOrderMonitor adopted the
      // exchange FILLED status into the ledger without accounting) may STILL be
      // resolved via operator attestation. We only refuse here when the order was
      // already accounted through the PROVEN-execution path (an applied execution
      // present). Idempotency and duplicate-accounting are enforced by
      // settleLiveOrderAttested: an identical existing attestation is a no-op, a
      // conflicting one throws, and the applied/manual/other-attestation guards
      // prevent double accounting.
      if (!existingAttestation) {
        const provenAccounted = [...(portfolio.stateModel.appliedExecutions ?? new Map())].some(
          ([, a]) => a.orderId === o.clientOrderId,
        );
        if (provenAccounted) {
          throw new Error(
            `order ${o.clientOrderId} was already accounted via a proven execution; refusing to attest (fail closed)`,
          );
        }
      }

      // Revalidate the fresh exchange evidence against the reloaded order (the
      // intended resolution). This is the in-lock evidence revalidation.
      const lockIdentityIssue = exchangeIdentityMismatch(fresh, current);
      if (lockIdentityIssue) {
        throw new Error(`exchange evidence identity mismatch (${lockIdentityIssue}); aborting`);
      }
      if (!fresh.filledQuantity.equals(current.quantity)) {
        throw new Error(`exchange evidence mismatch: reloaded order ${o.clientOrderId} quantity ${current.quantity} != exchange filled ${fresh.filledQuantity}`);
      }
      if (!fresh.averagePrice || !fresh.averagePrice.isPositive()) {
        throw new Error(`exchange evidence mismatch: order ${o.orderId} has no positive average execution price`);
      }

      // Apply accounting exactly once (idempotent by clientOrderId; a conflicting
      // repeat throws inside).
      portfolio = portfolio.settleLiveOrderAttested({
        clientOrderId: o.clientOrderId,
        symbol: current.symbol,
        side: current.side,
        orderQuantity: current.quantity,
        exchangeOrderId: o.orderId,
        exchangeStatus: fresh.status,
        attestedFilledQuantity: fresh.filledQuantity,
        attestedAveragePrice: fresh.averagePrice,
        fee: feeRes2.fee,
        feeCurrency: feeRes2.feeCurrency,
        evidenceSource: 'exchange_read',
        accountingAuthority: 'operator_attestation',
        provenanceProof: false,
        operatorConfirmedBy: o.operator,
        attestedAtMs: now(),
        exchangeReadAtMs,
        exchangeEvidence: evidence,
      });
      deps.live.save(portfolio.stateModel);

      // Update the order ledger, preserving the original identity.
      const updated: Order = {
        ...current,
        status: 'FILLED',
        filledQuantity: fresh.filledQuantity,
        averagePrice: fresh.averagePrice,
        fee: feeRes2.fee,
        feeCurrency: feeRes2.feeCurrency,
        updatedAtMs: now(),
      };
      deps.orders.save(updated);

      return { order: updated, attestation: portfolio.liveOrderAttestation(o.clientOrderId) };
    });

    const json: Record<string, unknown> = {
      outcome: 'ATTESTED',
      clientOrderId: applied.order.clientOrderId,
      exchangeOrderId: applied.order.exchangeOrderId,
      status: applied.order.status,
      filledQuantity: applied.order.filledQuantity.toString(),
      averagePrice: applied.order.averagePrice?.toString() ?? null,
      fee: applied.order.fee.toString(),
      feeCurrency: applied.order.feeCurrency,
      attestationId: applied.attestation?.attestationId ?? null,
      provenanceProof: false,
      accountingAuthority: 'operator_attestation',
    };
    return ok(
      [
        ...lines,
        '',
        'ATTESTATION APPLIED (operator attestation, provenanceProof=false).',
        `  order status:            ${applied.order.status}`,
        `  filled quantity:         ${applied.order.filledQuantity.toString()}`,
        `  average execution price: ${applied.order.averagePrice?.toString() ?? 'n/a'}`,
        `  fee:                     ${applied.order.fee.toString()} (${applied.order.feeCurrency})`,
        `  attestation:             ${applied.attestation?.attestationId ?? 'n/a'}`,
      ],
      json,
    );
  } catch (err) {
    return blocked(
      [`attestation aborted (fail closed, no partial mutation): ${err instanceof Error ? err.message : String(err)}`],
      { error: 'attestation_aborted', clientOrderId: o.clientOrderId },
    );
  }
}

export const resolveLiveOrderCommand: CommandHandler = async (args): Promise<number> => {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Configuration error:\n' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  if (!cfg.enableAuthenticatedReads) {
    // eslint-disable-next-line no-console
    console.error('The live-order resolution needs authenticated account reads, but NDAX_ENABLE_AUTHENTICATED_READS is not "true".');
    return 2;
  }

  const credentials: Record<string, string> = { apiKey: cfg.ndaxApiKey, apiSecret: cfg.ndaxApiSecret, userId: cfg.ndaxUserId, userName: cfg.ndaxUserName };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  let adapter;
  try {
    adapter = createExchange(cfg.exchange, { credentials, config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Could not construct the exchange adapter:\n' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const readOnly = toReadOnlyAdapter(adapter);
  const deps: ResolveLiveOrderDeps = {
    cfg: { stateDir: cfg.stateDir },
    adapter: readOnly,
    orders: new OrderStore(cfg.orderLedgerFile),
    live: new ManagedStateStore(cfg.liveManagedStateFile),
  };

  const result = await runResolveLiveOrder(deps, args);
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
