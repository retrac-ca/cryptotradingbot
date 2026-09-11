/**
 * `bot resolve-created-order` — operator-only quarantine/resolution of a durable
 * LIVE `CREATED` order whose exchange outcome is FUNDAMENTALLY AMBIGUOUS.
 *
 * A durable `CREATED` order (crash after persist-before-submit but before/around
 * SendOrder) may or may not have reached the exchange. The system cannot prove
 * which, because:
 *   - the submission may or may not have happened;
 *   - NDAX `ClientOrderId` lookup is not supported and its uniqueness is not
 *     proven (we send 0 by default);
 *   - heuristic matching by symbol/side/quantity/price is forbidden;
 *   - an exchange `OrderId` is the only reliable identity, and a CREATED order
 *     has none.
 *
 * This command therefore NEVER tries to reconstruct the exchange outcome
 * automatically. It offers exactly two explicit operator resolutions:
 *   A. ATTACH  — the operator asserts the exact exchange OrderId that belongs to
 *                this CREATED order; the command verifies the exchange order's
 *                identity (symbol/side/type/quantity/limit price) via READ-ONLY
 *                reads, attaches the id, and adopts the authoritative status.
 *   B. ABANDON — the operator deliberately closes the local CREATED record. This
 *                is NOT proof that no exchange order exists; it is an explicit
 *                operator acknowledgement that the outcome cannot be determined.
 *
 * SAFETY CONTRACT:
 *   - The exchange adapter is wrapped in a read-only proxy; no code path can
 *     reach `placeOrder`/`cancelOrder`. It NEVER submits, cancels, retries, or
 *     creates an exchange order.
 *   - ATTACH adopts authoritative status/fills but NEVER accounts a fill itself:
 *     accounting stays with the existing proven-execution / operator-attestation
 *     paths (`bot live-monitor` / `bot resolve-live-order`).
 *   - ABANDON never fabricates an exchange execution, cancellation, or rejection,
 *     and never touches the managed portfolio (no accounting, no reservation
 *     release).
 *   - All mutation happens under the canonical state-directory mutation lock with
 *     a TOCTOU reload + revalidation; any mismatch aborts before any mutation.
 *   - Explicit `--operator` and `--confirm` are required; there is no `--yes`,
 *     `--force`, environment bypass, or unattended path.
 *
 * Exit codes (existing CLI convention):
 *   0 = resolved safely
 *   2 = blocked / fail-closed (bad state, identity mismatch, read failure, TOCTOU)
 *   1 = error (config, malformed arguments, order not found, corrupt store)
 */

import { loadConfig } from '../config/load.js';
import { createExchange } from '../exchanges/index.js';
import { Portfolio } from '../portfolio/Portfolio.js';
import type { Order } from '../order.js';
import type { AccountTrade, Balance } from '../types.js';
import { OrderStore, withStateDirLock } from '../persistence/index.js';
import { toReadOnlyAdapter, type FeeCtx } from './manual-cmd.js';
import type { CommandHandler } from './context.js';

interface CliCommandResult {
  code: number;
  lines: string[];
  json: Record<string, unknown>;
}

const ok = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 0, lines, json });
const blocked = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 2, lines, json });
const failed = (lines: string[], json: Record<string, unknown>): CliCommandResult => ({ code: 1, lines, json });

type ResolutionMode = 'ATTACH' | 'ABANDON';

interface ResolveCreatedOrderArgs {
  clientOrderId: string;
  operator: string;
  mode: ResolutionMode | null;
  attachExchangeOrderId: string | null;
  reason: string;
  confirm: boolean;
}

function parseResolveCreatedOrderArgs(
  args: string[],
): { ok: true; opts: ResolveCreatedOrderArgs } | { ok: false; error: string } {
  const opts: ResolveCreatedOrderArgs = {
    clientOrderId: '',
    operator: '',
    mode: null,
    attachExchangeOrderId: null,
    reason: '',
    confirm: false,
  };
  let abandon = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--operator') {
      const v = args[++i];
      if (!v) return { ok: false, error: '--operator requires a value' };
      opts.operator = v;
    } else if (a === '--attach-exchange-order-id') {
      const v = args[++i];
      if (!v) return { ok: false, error: '--attach-exchange-order-id requires a value' };
      opts.attachExchangeOrderId = v;
    } else if (a === '--abandon') {
      abandon = true;
    } else if (a === '--reason') {
      const v = args[++i];
      if (!v) return { ok: false, error: '--reason requires a value' };
      opts.reason = v;
    } else if (a === '--confirm') {
      opts.confirm = true;
    } else if (a === '--json') {
      /* handled globally */
    } else if (a.startsWith('--')) {
      return {
        ok: false,
        error: `unknown argument "${a}". Usage: bot resolve-created-order <clientOrderId> --operator <name> (--attach-exchange-order-id <exchangeOrderId> | --abandon --reason "<reason>") --confirm [--json]`,
      };
    } else if (!opts.clientOrderId) {
      opts.clientOrderId = a;
    } else {
      return {
        ok: false,
        error: `unexpected positional argument "${a}". Usage: bot resolve-created-order <clientOrderId> --operator <name> (--attach-exchange-order-id <exchangeOrderId> | --abandon --reason "<reason>") --confirm [--json]`,
      };
    }
  }

  if (!opts.clientOrderId) return { ok: false, error: 'clientOrderId is required (the exact local CREATED order id)' };
  if (!opts.operator.trim()) return { ok: false, error: '--operator is required (operator identity for the audit trail)' };
  const hasAttach = opts.attachExchangeOrderId !== null;
  if (hasAttach && abandon) {
    return { ok: false, error: 'exactly one resolution is required: --attach-exchange-order-id OR --abandon (not both)' };
  }
  if (!hasAttach && !abandon) {
    return { ok: false, error: 'a resolution is required: --attach-exchange-order-id <exchangeOrderId> OR --abandon --reason "<reason>"' };
  }
  if (abandon) {
    opts.mode = 'ABANDON';
    if (!opts.reason.trim()) {
      return { ok: false, error: '--abandon requires an explicit --reason "<reason>"' };
    }
  } else {
    opts.mode = 'ATTACH';
    if (!/^\d+$/.test(opts.attachExchangeOrderId!)) {
      return { ok: false, error: `--attach-exchange-order-id "${opts.attachExchangeOrderId}" is not a valid exchange OrderId` };
    }
    if (!opts.reason.trim()) {
      opts.reason = 'operator attached a verified exchange OrderId to the CREATED order';
    }
  }
  if (!opts.confirm) {
    return { ok: false, error: 'explicit --confirm is required; no unattended resolution is permitted' };
  }
  return { ok: true, opts };
}

/** Dependencies for the testable resolve-created-order core (adapter is already read-only). */
export interface ResolveCreatedOrderDeps {
  cfg: { stateDir: string };
  adapter: FeeCtx;
  orders: OrderStore;
  nowMs?: () => number;
}

/**
 * Verify the operator-supplied exchange order identity against the durable
 * CREATED record. Returns the first mismatching field, or null when the exchange
 * order is exactly the asserted logical order. NEVER approximate.
 */
function attachIdentityMismatch(exchangeOrder: Order, local: Order, assertedExchangeOrderId: string): string | null {
  if (
    exchangeOrder.exchangeOrderId == null ||
    !Portfolio.sameExternalOrderId(exchangeOrder.exchangeOrderId, assertedExchangeOrderId)
  ) {
    return 'exchangeOrderId';
  }
  if (exchangeOrder.symbol !== local.symbol) return 'symbol';
  if (exchangeOrder.side !== local.side) return 'side';
  if (exchangeOrder.type !== local.type) return 'type';
  if (!exchangeOrder.quantity.equals(local.quantity)) return 'quantity';
  if (local.price != null) {
    if (exchangeOrder.price == null || !exchangeOrder.price.equals(local.price)) return 'limit price';
  }
  return null;
}

function renderEvidence(
  order: Order,
  exchangeOrder: Order | null,
  openOrders: Order[],
  history: Order[],
  trades: AccountTrade[],
  balances: Balance[],
): string[] {
  const lines: string[] = [
    'RESOLVE CREATED ORDER — OPERATOR ATTESTATION (NOT exchange-proven)',
    '  clientOrderId:            ' + order.clientOrderId,
    '  symbol / side / type:     ' + order.symbol + ' ' + order.side + ' ' + order.type,
    '  requested quantity:       ' + order.quantity.toString(),
    '  requested limit price:    ' + (order.price ? order.price.toString() : '(n/a)'),
    '  local status:             ' + order.status,
    '  exchangeOrderId:          ' + (order.exchangeOrderId ?? 'null (ambiguous)'),
  ];
  if (exchangeOrder) {
    lines.push(
      '',
      '  Asserted exchange order (read-only GetOrderStatus):',
      '    exchangeOrderId:        ' + (exchangeOrder.exchangeOrderId ?? 'n/a'),
      '    status:                 ' + exchangeOrder.status,
      '    symbol / side / type:   ' + exchangeOrder.symbol + ' ' + exchangeOrder.side + ' ' + exchangeOrder.type,
      '    quantity:               ' + exchangeOrder.quantity.toString(),
      '    filled quantity:        ' + exchangeOrder.filledQuantity.toString(),
      '    limit price:            ' + (exchangeOrder.price ? exchangeOrder.price.toString() : '(n/a)'),
      '    average exec price:     ' + (exchangeOrder.averagePrice ? exchangeOrder.averagePrice.toString() : 'n/a'),
    );
  }
  lines.push(
    '',
    '  Read-only account evidence (NOT claimed complete):',
    '    open orders:            ' + openOrders.length + (openOrders.length ? ' [' + openOrders.map((o) => o.exchangeOrderId ?? 'n/a').join(', ') + ']' : ''),
    '    order history:          ' + history.length,
    '    account trades:         ' + trades.length,
  );
  for (const b of balances) {
    lines.push('    balance ' + b.currency + ':           total=' + b.total.toString() + ' available=' + b.available.toString());
  }
  return lines;
}

/**
 * Resolve a durable LIVE CREATED order via an explicit operator action.
 * NEVER submits/cancels/retries; the exchange adapter is already read-only.
 */
export async function runResolveCreatedOrder(deps: ResolveCreatedOrderDeps, argv: string[]): Promise<CliCommandResult> {
  const parsed = parseResolveCreatedOrderArgs(argv);
  if (!parsed.ok) return failed([parsed.error], { error: parsed.error });
  const o = parsed.opts;
  const now = deps.nowMs ?? Date.now;

  // Initial durable read (before any lock): establish the target + symbol.
  const initial = deps.orders.get(o.clientOrderId);
  if (!initial) {
    return failed([`live order ${o.clientOrderId} not found in the order ledger`], { error: 'order_not_found', clientOrderId: o.clientOrderId });
  }
  if (initial.status !== 'CREATED') {
    return failed(
      [`order ${o.clientOrderId} status is ${initial.status}, not CREATED; it is already resolved or is not a CREATED order`],
      { error: 'not_created', clientOrderId: o.clientOrderId, status: initial.status },
    );
  }
  if (initial.exchangeOrderId != null) {
    return failed(
      [`order ${o.clientOrderId} already has exchangeOrderId ${initial.exchangeOrderId}; it is not an ambiguous CREATED order`],
      { error: 'already_has_exchange_id', clientOrderId: o.clientOrderId },
    );
  }

  // Fresh READ-ONLY exchange evidence (outside the mutation lock).
  let exchangeOrder: Order | null = null;
  let openOrders: Order[] = [];
  let history: Order[] = [];
  let trades: AccountTrade[] = [];
  let balances: Balance[] = [];
  try {
    if (o.mode === 'ATTACH') {
      exchangeOrder = await deps.adapter.getOrderStatus(initial.symbol, initial.clientOrderId, o.attachExchangeOrderId!);
    }
    openOrders = await deps.adapter.getOpenOrders(initial.symbol);
    history = await deps.adapter.getOrderHistory(initial.symbol);
    trades = await deps.adapter.getAccountTrades(initial.symbol);
    balances = await deps.adapter.getBalances();
  } catch (err) {
    return blocked(
      [`read-only exchange evidence read failed (${err instanceof Error ? err.message : String(err)}); fail closed, no mutation`],
      { error: 'exchange_read_failed', clientOrderId: o.clientOrderId },
    );
  }

  const lines = renderEvidence(initial, exchangeOrder, openOrders, history, trades, balances);

  // For ATTACH: the operator-supplied id must exactly match the exchange order
  // identity. This is the only "proof" here, and it is operator-asserted.
  if (o.mode === 'ATTACH' && exchangeOrder) {
    const issue = attachIdentityMismatch(exchangeOrder, initial, o.attachExchangeOrderId!);
    if (issue) {
      return blocked(
        [...lines, '', `exchange order identity mismatch (${issue}); fail closed, no mutation`],
        { error: 'exchange_identity_mismatch', clientOrderId: o.clientOrderId, field: issue },
      );
    }
  }

  if (o.mode === 'ABANDON') {
    lines.push(
      '',
      'WARNING: ABANDON is NOT proof that no exchange order exists.',
      'The exchange outcome cannot be proven from the available interfaces.',
      'Abandoning this local CREATED record does NOT prove that no exchange order exists.',
      'If an exchange order does exist, abandoning here does not cancel or close it.',
      'This is a LOCAL OPERATOR RESOLUTION, not an exchange outcome.',
    );
  }

  // Mutation under the canonical state-directory mutation lock with TOCTOU reload.
  try {
    const applied = withStateDirLock(deps.cfg.stateDir, () => {
      const current = deps.orders.get(o.clientOrderId);
      if (!current) throw new Error(`order ${o.clientOrderId} no longer exists`);
      if (current.status !== 'CREATED') {
        throw new Error(`order ${o.clientOrderId} is no longer CREATED (status ${current.status}); already resolved`);
      }
      if (current.exchangeOrderId != null) {
        throw new Error(`order ${o.clientOrderId} already has exchangeOrderId ${current.exchangeOrderId}; already resolved`);
      }
      // TOCTOU: the durable identity/details must be unchanged since the initial read.
      if (
        current.symbol !== initial.symbol ||
        current.side !== initial.side ||
        current.type !== initial.type ||
        !current.quantity.equals(initial.quantity) ||
        (current.price ?? null)?.toString() !== (initial.price ?? null)?.toString() ||
        current.reason !== initial.reason
      ) {
        throw new Error(`order ${o.clientOrderId} changed after the initial read; aborting (TOCTOU)`);
      }

      if (o.mode === 'ATTACH') {
        const exchange = exchangeOrder;
        if (!exchange) throw new Error('exchange order evidence is missing');
        const issue = attachIdentityMismatch(exchange, current, o.attachExchangeOrderId!);
        if (issue) throw new Error(`exchange order identity mismatch (${issue}); aborting`);
        const attached: Order = {
          ...exchange,
          clientOrderId: current.clientOrderId,
          reason: current.reason,
          createdAtMs: current.createdAtMs,
          resolution: {
            kind: 'ATTACH',
            operator: o.operator,
            reason: o.reason,
            resolvedAtMs: now(),
            accountingAuthority: 'operator_attestation',
            provenanceProof: false,
            exchangeOrderId: o.attachExchangeOrderId,
            evidence:
              'operator-supplied exchange OrderId verified by exact identity against read-only GetOrderStatus; no exchange mutation performed; no fill accounting applied here',
          },
        };
        deps.orders.save(attached);
        return { order: attached, mode: 'ATTACH' as const };
      }

      const abandoned: Order = {
        ...current,
        status: 'ABANDONED',
        updatedAtMs: now(),
        resolution: {
          kind: 'ABANDON',
          operator: o.operator,
          reason: o.reason,
          resolvedAtMs: now(),
          accountingAuthority: 'operator_attestation',
          provenanceProof: false,
          exchangeOrderId: null,
          evidence:
            'operator reviewed read-only exchange evidence (open orders, order history, account trades, balances); no exchange outcome was proven',
        },
      };
      deps.orders.save(abandoned);
      return { order: abandoned, mode: 'ABANDON' as const };
    });

    const json: Record<string, unknown> = {
      outcome: applied.mode,
      clientOrderId: applied.order.clientOrderId,
      status: applied.order.status,
      exchangeOrderId: applied.order.exchangeOrderId,
      operator: applied.order.resolution?.operator ?? null,
      resolvedAtMs: applied.order.resolution?.resolvedAtMs ?? null,
      reason: applied.order.resolution?.reason ?? null,
      accountingAuthority: applied.order.resolution?.accountingAuthority ?? null,
      provenanceProof: applied.order.resolution?.provenanceProof ?? null,
    };

    const footer =
      applied.mode === 'ATTACH'
        ? [
            '',
            'ATTACH APPLIED (operator-attested identity; provenanceProof=false).',
            `  order status:            ${applied.order.status}`,
            `  exchangeOrderId:         ${applied.order.exchangeOrderId ?? 'n/a'}`,
            'No fill was accounted here. If the order is FILLED, use `bot live-monitor` /',
            '`bot resolve-live-order` for proven-execution or operator-attested accounting.',
          ]
        : [
            '',
            'ABANDON APPLIED (LOCAL OPERATOR RESOLUTION; provenanceProof=false).',
            `  order status:            ${applied.order.status}`,
            'The local CREATED record is now terminal. This did NOT prove that the exchange',
            'has no order, and did NOT cancel/close any exchange order.',
          ];
    return ok([...lines, ...footer], json);
  } catch (err) {
    return blocked(
      [`resolution aborted (fail closed, no partial mutation): ${err instanceof Error ? err.message : String(err)}`],
      { error: 'resolution_aborted', clientOrderId: o.clientOrderId },
    );
  }
}

export const resolveCreatedOrderCommand: CommandHandler = async (args): Promise<number> => {
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
    console.error('Resolving a CREATED order needs authenticated account reads, but NDAX_ENABLE_AUTHENTICATED_READS is not "true".');
    return 2;
  }

  const credentials: Record<string, string> = {
    apiKey: cfg.ndaxApiKey,
    apiSecret: cfg.ndaxApiSecret,
    userId: cfg.ndaxUserId,
    userName: cfg.ndaxUserName,
  };
  if (cfg.ndaxAccountId !== undefined) credentials.accountId = String(cfg.ndaxAccountId);
  let adapter;
  try {
    adapter = createExchange(cfg.exchange, {
      credentials,
      config: { enableAuthenticatedReads: true, baseUrl: cfg.ndaxRestBaseUrl },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Could not construct the exchange adapter:\n' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  const readOnly = toReadOnlyAdapter(adapter);
  const deps: ResolveCreatedOrderDeps = {
    cfg: { stateDir: cfg.stateDir },
    adapter: readOnly,
    orders: new OrderStore(cfg.orderLedgerFile),
  };

  const result = await runResolveCreatedOrder(deps, args);
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
