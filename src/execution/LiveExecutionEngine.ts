/**
 * Live execution engine — safety-critical order placement for LIVE trading.
 *
 * This engine is deliberately conservative. Its job is to move a fully
 * risk-approved order to the real exchange without ever creating a duplicate or
 * a destructive mistake, and to treat the exchange as authoritative. It owns
 * the RiskManager and REQUIRES RiskManager portfolio-level approval before any
 * order can be submitted — a strategy can never reach LiveOrderEngine directly
 * and a caller cannot bypass risk by omitting approval: `place()` internally
 * runs `riskManager.evaluate(ctx)` and refuses to submit unless approved.
 *
 * The live execution path is: Strategy -> RiskManager -> LiveOrderEngine ->
 * OrderStore -> ExchangeAdapter/NDAX. The engine builds the order from the
 * RiskManager's approved sizing in `place()`, so no external pre-sized order can
 * be injected past risk.
 *
 * Hard safety properties (all enforced here):
 *  1. GATED START — the engine refuses to operate unless the caller passes the
 *     explicit LiveSafetyGate (TRADING_MODE=live + realFundsAtRisk=true) and the
 *     adapter declares `supportsOrderPlacement`. Absent these it throws.
 *  2. RISK GATE — every placement runs RiskManager.evaluate on the provided
 *     RiskContext. If it is not approved the order is refused (REJECTED) and the
 *     exchange is never contacted. The order quantity/side/notional come from
 *     the risk decision, not from any caller-supplied NewOrder.
 *  3. PERSIST-BEFORE-SUBMIT — every order is recorded in the OrderStore keyed by
 *     its internally-generated clientOrderId as CREATED before any network call,
 *     so a crash/duplicate retry can never submit the same order twice. A
 *     pre-existing CREATED/OPEN order with the same key causes a defensive
 *     rejection (reconcile instead). Duplicate protection does NOT rely on any
 *     exchange-side idempotency key (NDAX ClientOrderId is documented as
 *     potentially non-unique).
 *  4. NO AUTO-RETRY ON AMBIGUOUS OUTCOME — if placeOrder returns `unknownOutcome`
 *     or throws a timeout/network/ambiguous error, the order is NOT retried. It
 *     is transitioned to UNKNOWN and the caller must reconcile with the exchange
 *     (GetOrderStatus/GetOpenOrders) before deciding anything.
 *  5. PRECISION & BALANCE VALIDATION — quantity is validated against the
 *     market's quantityTick and the real available balance; prices against the
 *     priceTick; minimum order size is enforced (defense-in-depth on top of the
 *     RiskManager's own sizing checks, re-checked against live market state).
 *  6. FAIL CLOSED — any uncertainty about an order's disposition surfaces as
 *     UNKNOWN/Api-vs-local mismatch rather than a guess.
 */

import { randomUUID } from 'node:crypto';
import { Money } from '../money/Money.js';
import type { NewOrder, Order, OrderStatus, OrderType } from '../order.js';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter.js';
import {
  NetworkError,
  TimeoutError,
  InvalidResponseError,
  UnknownOrderOutcomeError,
  OrderRejectedError,
} from '../exchanges/errors.js';
import { OrderStore } from '../persistence/OrderStore.js';
import { ReconcileService } from '../reconcile/ReconcileService.js';
import { RiskManager } from '../risk/RiskManager.js';
import type { RiskApproval, RiskRejection } from '../risk/Reason.js';
import type { RiskContext } from '../risk/RiskContext.js';
import { classifyReattachment } from './recovery.js';
import type { ReattachmentPolicy } from './recovery.js';

export interface LiveGate {
  tradingMode: 'live';
  /** Human acknowledgement that real funds are at risk. */
  realFundsAtRisk: boolean;
}

export interface LiveExecutionConfig {
  gate: LiveGate;
  /** If true, refuse any new LIVE order placement (global/remote kill switch). */
  killSwitch: boolean;
  /** Max ms to wait for exchange to acknowledge an order. Default 15s. */
  ackTimeoutMs?: number;
  /**
   * True ONLY when the exchange contract provably guarantees the client order id
   * is a UNIQUE logical-order identifier (safe for client-order-id
   * re-attachment). NDAX documents `ClientOrderId` as a long integer "(may not
   * be unique)", so it is FALSE for NDAX; leaving recovery fail-closed there.
   * Exchange-agnostic: a future exchange declaring uniqueness may set it.
   */
  reattachmentClientOrderIdIsUnique?: boolean;
}

export interface LiveOrderIntent {
  /** Human reason this order is being placed, for auditability. */
  reason: string;
  /**
   * The order type to submit. The live path only safely supports `'market'`
   * (no limit price flows from the risk approval), so any other type is
   * REJECTED rather than silently converted. Defaults to `'market'` for
   * backward compatibility with existing callers.
   */
  type?: OrderType;
}

export interface LiveOrderResult {
  order: Order;
  /** True if the placement outcome is unknown and reconciliation is required. */
  unknownOutcome: boolean;
  /** Human-readable status message for CLI/logging (redacted). */
  message: string;
}

/** Outcome of attempting to resolve an ambiguous/stale order against the exchange. */
export interface RecoveryResult {
  order: Order;
  outcome: 'REFRESHED' | 'UNIQUE_ATTACHED' | 'UNRESOLVED';
  /** Human-readable outcome, for logging/operator. */
  message: string;
}

/** Rejections are definite (safe to surface immediately, never automatically retried). */
export class LiveGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveGateError';
  }
}

export class LiveOrderEngine {
  private readonly adapter: ExchangeAdapter;
  private readonly store: OrderStore;
  private readonly reconcileService: ReconcileService;
  private readonly riskManager: RiskManager;
  private readonly cfg: Required<LiveExecutionConfig>;

  constructor(
    adapter: ExchangeAdapter,
    store: OrderStore,
    reconcile: ReconcileService,
    riskManager: RiskManager,
    cfg: LiveExecutionConfig,
  ) {
    this.adapter = adapter;
    this.store = store;
    this.reconcileService = reconcile;
    this.riskManager = riskManager;
    this.cfg = {
      ackTimeoutMs: cfg.ackTimeoutMs ?? 15_000,
      reattachmentClientOrderIdIsUnique: cfg.reattachmentClientOrderIdIsUnique ?? false,
      ...cfg,
    };
    this.assertGate();
  }

  /** Refuse construction unless all safety gates pass. */
  private assertGate(): void {
    if (this.cfg.gate.tradingMode !== 'live') {
      throw new LiveGateError('live order engine requires trading mode "live"');
    }
    if (!this.cfg.gate.realFundsAtRisk) {
      throw new LiveGateError(
        'realFundsAtRisk must be explicitly acknowledged to place live orders',
      );
    }
    if (this.cfg.killSwitch) {
      throw new LiveGateError('kill switch is active; live order placement is disabled');
    }
    if (!this.adapter.capabilities.supportsOrderPlacement) {
      throw new LiveGateError(
        `exchange adapter ${this.adapter.id} does not support order placement; live trading is unavailable`,
      );
    }
  }

  get killSwitch(): boolean {
    return this.cfg.killSwitch;
  }

  /**
   * Risk-gate and place a single live order.
   *
   * The ONLY public entry point into live execution. It runs the owned
   * RiskManager against the provided RiskContext; if risk rejects the intent the
   * order is refused (REJECTED) and the exchange is never contacted. The order
   * quantity/side/notional are taken from the risk decision (never from external
   * callers), and the clientOrderId is generated internally. This makes it
   * structurally impossible for a strategy to invoke live execution directly or
   * for a caller to bypass RiskManager portfolio-level approval.
   *
   * On an ambiguous outcome the returned order has status `UNKNOWN` and
   * `unknownOutcome === true`; do NOT retry — reconcile instead.
   */
  async place(ctx: RiskContext, intent: LiveOrderIntent): Promise<LiveOrderResult> {
    this.assertGate();

    const decision = this.riskManager.evaluate(ctx);
    if (!decision.approved) {
      return this.riskRejected(ctx.symbol, decision, intent.reason);
    }
    const order = this.orderFromApproval(ctx.symbol, decision, intent);
    return this.submit(order);
  }

  // ---- internal risk-gating + submission ----

  /** Refuse an order that RiskManager did not approve. Never contacts the exchange. */
  private riskRejected(symbol: string, decision: RiskRejection, reason: string): LiveOrderResult {
    const now = Date.now();
    const rejected: Order = {
      clientOrderId: `${this.nextClientOrderId(symbol)}`,
      exchangeOrderId: null,
      symbol,
      side: decision.side ?? 'BUY',
      type: 'market',
      status: 'REJECTED',
      quantity: Money.zero(),
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'unknown',
      reason: `${reason} [risk rejected: ${decision.reason}${decision.detail ? `: ${decision.detail}` : ''}]`,
      createdAtMs: now,
      updatedAtMs: now,
    };
    return {
      order: rejected,
      unknownOutcome: false,
      message: `risk rejected: ${decision.reason}${decision.detail ? `: ${decision.detail}` : ''}`,
    };
  }

  /** Build the NewOrder strictly from the risk-approved decision (not from callers). */
  private orderFromApproval(
    symbol: string,
    approval: RiskApproval,
    intent: LiveOrderIntent,
  ): NewOrder {
    // The order type is explicit on the intent. The live path only safely
    // supports 'market' (there is no limit price flowing from the risk approval),
    // so an unsupported type is REJECTED rather than silently converted to a
    // market order.
    const type = intent.type ?? 'market';
    if (type !== 'market') {
      throw new LiveGateError(
        `unsupported live order type "${type}"; only "market" is supported — refusing to silently convert an order type`,
      );
    }
    return {
      clientOrderId: this.nextClientOrderId(symbol),
      symbol,
      side: approval.side,
      type,
      quantity: approval.quantity,
      reason: intent.reason,
    };
  }

  /**
   * Persist-before-submit + submit + classify. Mutates only the OrderStore and
   * the adapter (via placeOrder). Never retries ambiguous outcomes.
   */
  private async submit(order: NewOrder): Promise<LiveOrderResult> {
    await this.validateOrder(order);

    // Persist-before-submit: claim the internally-generated clientOrderId.
    if (this.store.get(order.clientOrderId)) {
      return {
        order: this.buildRejected(order, 'DUPLICATE_CLIENT_ORDER_ID: an order with this id already exists; reconcile instead of re-submitting'),
        unknownOutcome: false,
        message: 'refused: duplicate clientOrderId',
      };
    }
    const created = this.buildRecorded(order, 'CREATED');
    this.store.save(created);

    try {
      const result = await this.withAckTimeout(order, this.adapter.placeOrder(order));
      if (result.unknownOutcome) {
        const unknown = this.buildRecorded(order, 'UNKNOWN', result.exchangeOrderId ?? null);
        this.store.save(unknown);
        return {
          order: unknown,
          unknownOutcome: true,
          message: 'submission outcome unknown; reconcile with the exchange before any action',
        };
      }
      const acked = this.buildRecorded(
        order,
        'SUBMITTED',
        result.exchangeOrderId ?? null,
      );
      this.store.save(acked);
      return { order: acked, unknownOutcome: false, message: 'order acknowledged by exchange' };
    } catch (err) {
      return this.handleSubmissionError(order, err);
    }
  }

  /**
   * Durable, collision-resistant local order identity (Gate 7.1).
   *
   * The previous `live-<symbol>-<Date.now()>-<seq>` id was only unique within a
   * single process and could be regenerated differently across a restart, which
   * breaks exactly-once intent (a crash could lose the link between an attempt
   * and a retried logical intent). This uses `crypto.randomUUID()` so uniqueness
   * does not depend on wall-clock time or an in-memory sequence and holds across
   * process restarts / concurrent logical orders. It is generated BEFORE
   * submission and persisted as the `OrderStore` key, and it is never regenerated
   * when an order is reloaded or refreshed (`refreshOrder` only mutates status /
   * exchangeOrderId), so an order keeps one identity for its whole life,
   * including through `UNKNOWN`.
   */
  private nextClientOrderId(symbol: string): string {
    return `live-${symbol.replace('/', '')}-${randomUUID()}`;
  }

  /** Poll the exchange for the authoritative state of an order (reconciliation). */
  async refreshOrder(order: Order): Promise<Order> {
    if (!order.exchangeOrderId) {
      // Cannot look it up definitively without an exchange id => keep unknown.
      return order;
    }
    const live = await this.adapter.getOrderStatus(order.symbol, order.clientOrderId, order.exchangeOrderId);
    this.store.save(live);
    return live;
  }

  /** Convenience: full reconcile-and-store based on a single order. */
  async reconcile(): Promise<ReturnType<ReconcileService['reconcile']>> {
    return this.reconcileService.reconcile();
  }

  /**
   * Resolve an ambiguous (`UNKNOWN`) or stale order against the exchange
   * (Gate 7.3). READ-ONLY: it only calls account read methods and the local
   * OrderStore; it NEVER submits, cancels, retries, releases a reservation, or
   * applies a fill.
   *
   * - If the local order already has an `exchangeOrderId`, it refreshes the
   *   authoritative state (existing path).
   * - If the order has NO `exchangeOrderId` (a lost/ambiguous submission), it
   *   gathers the exchange's open orders + history and classifies the result
   *   using ONLY provable identities (`classifyReattachment`). A UNIQUE
   *   provable match reattaches the exchange order id AND adopts the
   *   authoritative status/fills; the durable local `clientOrderId` is preserved.
   * - ZERO / MULTIPLE / MALFORMED / read-failure all leave the order as-is
   *   (`UNRESOLVED`) so it REMAINS UNKNOWN: a zero match is NOT proof the order
   *   was rejected, and we NEVER heuristically pick the "closest" order.
   *
   * Fills adopted here are trusted ONLY when they carry a trustworthy
   * `executionId` (Gate 7.2); without one, Gate 7.2 blocks automatic accounting.
   */
  async recoverOrder(order: Order): Promise<RecoveryResult> {
    if (order.exchangeOrderId) {
      const live = await this.adapter.getOrderStatus(order.symbol, order.clientOrderId, order.exchangeOrderId);
      this.store.save(live);
      return { order: live, outcome: 'REFRESHED', message: 'order refreshed by exchange order id' };
    }

    let candidates: Order[];
    try {
      candidates = await this.gatherCandidates(order.symbol);
    } catch (err) {
      return {
        order,
        outcome: 'UNRESOLVED',
        message: `recovery reads failed (${err instanceof Error ? err.name : 'unknown'}); order remains UNKNOWN`,
      };
    }
    const res = classifyReattachment(order, candidates, this.reattachmentPolicy());
    if (res.outcome === 'UNIQUE_MATCH' && res.order) {
      // Same exchange order must never attach to TWO local logical orders: if a
      // DIFFERENT local order already owns this exchange order id, fail closed.
      const alreadyOwned = [...this.store.allOrders().values()].find(
        (o) => o.exchangeOrderId === res.order!.exchangeOrderId && o.clientOrderId !== order.clientOrderId,
      );
      if (alreadyOwned) {
        return {
          order,
          outcome: 'UNRESOLVED',
          message: `exchange order ${res.order.exchangeOrderId} is already attached to local order ` +
            `${alreadyOwned.clientOrderId}; refusing to reattach (fail closed)`,
        };
      }
      // Merge authoritative exchange state, PRESERVING the durable local order id.
      const attached: Order = {
        ...res.order,
        clientOrderId: order.clientOrderId,
        reason: order.reason,
        createdAtMs: order.createdAtMs,
      };
      this.store.save(attached);
      return {
        order: attached,
        outcome: 'UNIQUE_ATTACHED',
        message: `reattached to exchange order ${res.order.exchangeOrderId}`,
      };
    }
    return {
      order,
      outcome: 'UNRESOLVED',
      message: `recovery unresolved (${res.outcome}); order remains UNKNOWN; no automatic retry`,
    };
  }

  private reattachmentPolicy(): ReattachmentPolicy {
    return { clientOrderIdIsUnique: this.cfg.reattachmentClientOrderIdIsUnique };
  }

  private async gatherCandidates(symbol: string): Promise<Order[]> {
    const open = await this.adapter.getOpenOrders(symbol);
    const history = await this.adapter.getOrderHistory(symbol);
    // An order may appear in BOTH open orders and history; dedupe by a
    // trustable identity so a single order is never considered a MULTIPLE match.
    // Unidentifiable orders (no exchange/client id) are kept as-is; they can
    // never satisfy a provable match and are harmless to classification.
    const out: Order[] = [];
    const seen = new Set<string>();
    for (const o of [...open, ...history]) {
      if (o.exchangeOrderId) {
        if (seen.has(o.exchangeOrderId)) continue;
        seen.add(o.exchangeOrderId);
      } else if (o.clientOrderId) {
        const k = `c:${o.clientOrderId}`;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(o);
    }
    return out;
  }

  // ---- internals ----

  /**
   * Validate an order against market constraints before submission. Public only
   * as a test seam; the engine always validates internally before placing.
   */
  async validateOrder(order: NewOrder): Promise<void> {
    if (!order.quantity.isPositive()) {
      throw new LiveGateError('order quantity must be positive');
    }
    const market = await this.adapter.getMarketInfo(order.symbol);
    // Quantity on the tick grid.
    const qty = order.quantity;
    if (!market.quantityTick.isZero() && !qty.isMultipleOf(market.quantityTick)) {
      throw new LiveGateError(
        `quantity ${qty.toString()} is not a multiple of quantity tick ${market.quantityTick.toString()}`,
      );
    }
    // Min order size (either base or quote floor).
    if (market.minOrderBase && qty.compareTo(market.minOrderBase) < 0) {
      throw new LiveGateError(`quantity below minimum order size ${market.minOrderBase.toString()}`);
    }
    // Limit price on the tick grid.
    if (order.type === 'limit') {
      if (!order.price || !order.price.isPositive()) {
        throw new LiveGateError('limit order requires a positive price');
      }
      if (!market.priceTick.isZero() && !order.price.isMultipleOf(market.priceTick)) {
        throw new LiveGateError(
          `limit price ${order.price.toString()} is not a multiple of price tick ${market.priceTick.toString()}`,
        );
      }
      if (market.minOrderQuote && order.price.mul(qty).compareTo(market.minOrderQuote) < 0) {
        throw new LiveGateError(`order notional below minimum order size`);
      }
    }
    // Balance availability for BUY (quote) / SELL (base).
    await this.assertSufficientBalance(order);
  }

  private async assertSufficientBalance(order: NewOrder): Promise<void> {
    const [base, quote] = order.symbol.split('/');
    const balances = await this.adapter.getBalances();
    if (order.side === 'BUY') {
      const quoteBal = balances.find((b) => b.currency === quote);
      const ticker = await this.adapter.getTicker(order.symbol);
      const refPrice = (order.price ?? null) ?? ticker.last;
      if (!refPrice) {
        throw new LiveGateError(`cannot determine reference price for ${order.symbol} to validate balance`);
      }
      const required = order.quantity.mul(refPrice);
      if (!quoteBal || quoteBal.available.compareTo(required) < 0) {
        throw new LiveGateError(
          `insufficient ${quote} available balance for BUY order (need ${required.toString()})`,
        );
      }
    } else {
      const baseBal = balances.find((b) => b.currency === base);
      if (!baseBal || baseBal.available.compareTo(order.quantity) < 0) {
        throw new LiveGateError(
          `insufficient ${base} available balance for SELL order (need ${order.quantity.toString()})`,
        );
      }
    }
  }

  /** Run placeOrder but fail closed on timeout at the ack boundary. */
  private async withAckTimeout<T>(order: NewOrder, p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`acknowledgement timeout for order ${order.clientOrderId}`)),
        this.cfg.ackTimeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleSubmissionError(order: NewOrder, err: unknown): LiveOrderResult {
    if (err instanceof TimeoutError || err instanceof NetworkError || err instanceof InvalidResponseError || err instanceof UnknownOrderOutcomeError) {
      // AMBIGUOUS — the exchange may have accepted the order. Do NOT retry.
      const unknown = this.buildRecorded(order, 'UNKNOWN', null);
      this.store.save(unknown);
      return {
        order: unknown,
        unknownOutcome: true,
        message: `ambiguous outcome (${err.name}); reconcile with the exchange before any action`,
      };
    }
    if (err instanceof OrderRejectedError) {
      // DEFINITE rejection — safe to mark rejected; no retry.
      const rejected = this.buildRejected(order, err.message);
      this.store.save(rejected);
      return { order: rejected, unknownOutcome: false, message: `order rejected: ${err.message}` };
    }
    // Otherwise unknown transport/exchange error: fail closed as ambiguous.
    const unknown = this.buildRecorded(order, 'UNKNOWN', null);
    this.store.save(unknown);
    return {
      order: unknown,
      unknownOutcome: true,
      message: `unexpected error (${err instanceof Error ? err.name : 'unknown'}); reconcile before any action`,
    };
  }

  private buildRecorded(order: NewOrder, status: OrderStatus, exchangeOrderId: string | null = null): Order {
    const now = Date.now();
    return {
      clientOrderId: order.clientOrderId,
      exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status,
      quantity: order.quantity,
      filledQuantity: Money.zero(),
      averagePrice: null,
      price: order.price ?? null,
      fills: [],
      fee: Money.zero(),
      feeCurrency: 'unknown',
      reason: order.reason,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  private buildRejected(order: NewOrder, reason: string): Order {
    const o = this.buildRecorded(order, 'REJECTED', null);
    o.reason = `${order.reason} [rejected: ${reason}]`;
    return o;
  }
}
