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

import { Money } from '../money/Money.js';
import type { NewOrder, Order, OrderStatus } from '../order.js';
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
  /** When a read/ack fails and we cannot determine the outcome. */
}

export interface LiveOrderIntent {
  /** Human reason this order is being placed, for auditability. */
  reason: string;
}

export interface LiveOrderResult {
  order: Order;
  /** True if the placement outcome is unknown and reconciliation is required. */
  unknownOutcome: boolean;
  /** Human-readable status message for CLI/logging (redacted). */
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
  private readonly seq = { n: 0 };

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
    const order = this.orderFromApproval(ctx.symbol, decision, intent.reason);
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
      feeCurrency: 'quote',
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
    reason: string,
  ): NewOrder {
    return {
      clientOrderId: this.nextClientOrderId(symbol),
      symbol,
      side: approval.side,
      type: 'market',
      quantity: approval.quantity,
      reason,
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

  /** Monotonic, per-process unique local idempotency key for a live order. */
  private nextClientOrderId(symbol: string): string {
    this.seq.n += 1;
    return `live-${symbol.replace('/', '')}-${Date.now()}-${this.seq.n}`;
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
      feeCurrency: 'quote',
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
