/**
 * Portfolio — tracks cash, positions, average entry price, cost basis, and P&L.
 *
 * All math is `Money` (fixed-point BigInt). Fills are applied via `applyFill`,
 * which handles both opening/scaling a long (BUY) and reducing/closing a long
 * (SELL), updating average entry price, cost basis, realized P&L, and fees.
 */

import { Money } from '../money/Money.js';
import type { OrderSide, Fill, FeeCurrency } from '../order.js';
import type { Balance } from '../types.js';
import type {
  PortfolioModel,
  PaperPosition,
  SourceQuantities,
  OrderReservation,
  AppliedExecution,
  ManualSettlement,
  LiveOrderAttestation,
  ExchangeEvidenceSnapshot,
} from './types.js';

/** Optional ownership seed for a fresh portfolio. */
export interface PortfolioOwnershipSeed {
  /** Non-bot assets recorded at onboarding (never sold unless authorized). */
  externalSnapshot?: Map<string, Money>;
  /** Symbols the user explicitly authorized the bot to manage. */
  authorizedExternal?: Set<string>;
}

export class Portfolio {
  private readonly state: PortfolioModel;

  private constructor(state: PortfolioModel) {
    this.state = state;
  }

  /** Create an empty managed portfolio seeded with initial cash by currency. */
  static empty(
    initialCash: Map<string, Money> = new Map(),
    ownership: PortfolioOwnershipSeed = {},
  ): Portfolio {
    return new Portfolio({
      cash: new Map(initialCash),
      positions: new Map(),
      peakEquity: Portfolio.equityOf({ cash: new Map(initialCash), positions: new Map() }),
      realizedPnl: Money.zero(),
      totalFees: Money.zero(),
      externalSnapshot: new Map(ownership.externalSnapshot ?? []),
      authorizedExternal: new Set(ownership.authorizedExternal ?? []),
      reserved: new Map(),
      orderReservations: new Map(),
      appliedExecutions: new Map(),
      manualSettlements: new Map(),
      liveOrderAttestations: new Map(),
    });
  }

  /** Rebuild from a persisted model (restart recovery). */
  static fromModel(state: PortfolioModel): Portfolio {
    return new Portfolio(state);
  }

  /** Current state (read-only). */
  get stateModel(): PortfolioModel {
    return this.state;
  }

  cash(currency: string): Money {
    return this.state.cash.get(currency) ?? Money.zero();
  }

  position(symbol: string): PaperPosition | null {
    return this.state.positions.get(symbol) ?? null;
  }

  // --- Ownership (external vs bot-managed) ---

  /**
   * Non-bot holdings for a symbol (recorded at onboarding). Zero when there is
   * no external inventory for it. External inventory is NEVER bot-tradable.
   */
  external(symbol: string): Money {
    return this.state.externalSnapshot.get(symbol) ?? Money.zero();
  }

  /** Read-only view of the external snapshot. */
  externalSnapshotView(): ReadonlyMap<string, Money> {
    return this.state.externalSnapshot;
  }

  /** True if the user explicitly authorized this asset to be bot-managed. */
  isAuthorizedExternal(symbol: string): boolean {
    return this.state.authorizedExternal.has(symbol);
  }

  /**
   * Record the onboarding snapshot of external holdings (merge-over). Existing
   * managed positions are untouched. Returns a new Portfolio.
   *
   * F-10: `externalSnapshot` is the operator's DECLARATION of pre-existing,
   * non-bot holdings — evidence-independent of the exchange balance. It is never
   * derived from an exchange balance. A negative amount is corrupt (it would
   * under-count expected balances) and is rejected (fail closed). Merge-over
   * never silently erases a previously-declared external holding.
   *
   * @throws on a negative external amount.
   */
  withExternalSnapshot(snapshot: Map<string, Money>): Portfolio {
    if (snapshot.size === 0) return this;
    const state = this.cloneState();
    for (const [cur, amount] of snapshot) {
      if (amount.isNegative()) {
        throw new Error(`Portfolio.withExternalSnapshot: negative external amount for ${cur}`);
      }
      state.externalSnapshot.set(cur, amount);
    }
    return new Portfolio(state);
  }

  /**
   * Mark an external asset as authorized so the bot may manage it.
   *
   * Semantics (ownership invariant, Gate 5.5 / F-6):
   *   - The FULL external quantity is added to the managed position for this
   *     symbol: `managed quantity = external quantity + existing managed quantity`.
   *   - Existing BOT-managed inventory is NEVER lost, overwritten, or silently
   *     reclassified. Provenance is preserved per source in `sourceQuantities`.
   *   - The external snapshot entry is consumed (deleted) only AFTER the add, so
   *     no quantity evaporates and `expectedAssetBalances()` stays correct
   *     (managed + remaining external).
   *   - The externally-authorized portion carries zero cost basis (it was
   *     previously-owned; there is no bot acquisition cost). Any existing BOT
   *     cost basis is preserved.
   *   - Idempotent: re-authorizing after the snapshot is already consumed is a
   *     safe no-op (returns this). It never duplicates or inflates quantity.
   *   - Fail closed: if there is NO external inventory for the symbol and it was
   *     not already authorized, it throws (we never manufacture a position).
   *
   * @throws when the symbol has no external inventory to authorize and the user
   *         has not already authorized it.
   */
  authorizeExternal(symbol: string): Portfolio {
    const externalQty = this.external(symbol);
    const managed = this.position(symbol);

    // F-10: a negative external quantity is corrupt state (validation prevents it
    // from ever being loaded/created); guard defensively so an authorization can
    // never manufacture a negative/incorrect managed position.
    if (externalQty.isNegative()) {
      throw new Error(`Portfolio.authorizeExternal: negative external inventory for ${symbol}`);
    }

    if (externalQty.isZero()) {
      // No NEW external inventory to authorize. If the user has already
      // authorized this symbol (even if the resulting position was fully sold
      // since), re-authorizing is a safe idempotent no-op. Otherwise there is
      // genuinely nothing to authorize and we fail closed.
      if (this.isAuthorizedExternal(symbol)) {
        return this;
      }
      throw new Error(`Portfolio.authorizeExternal: no external inventory for ${symbol}`);
    }

    const state = this.cloneState();
    state.authorizedExternal.add(symbol);

    if (managed) {
      // Merging: add the external quantity on top of the existing managed
      // (BOT) position. Preserve BOT cost basis; the authorized external
      // portion contributes zero cost. Never overwrite the existing quantity.
      const newQty = managed.quantity.add(externalQty);
      state.positions.set(symbol, {
        ...managed,
        quantity: newQty,
        averageEntryPrice: newQty.isZero() ? Money.zero() : managed.costBasis.div(newQty),
        sourceQuantities: Portfolio.mergeExternalBreakdown(managed, externalQty),
      });
    } else {
      // Fresh external authorization: no pre-existing managed position.
      state.positions.set(symbol, {
        symbol,
        quantity: externalQty,
        costBasis: Money.zero(),
        averageEntryPrice: Money.zero(),
        realizedPnl: Money.zero(),
        feesPaid: Money.zero(),
        source: 'EXTERNAL_AUTHORIZED',
        sourceQuantities: { BOT: Money.zero(), EXTERNAL_AUTHORIZED: externalQty },
      });
    }

    state.externalSnapshot.delete(symbol);
    return new Portfolio(state);
  }

  // --- Reserved / deployable quote ---

  /** Quote reserved by in-flight bot BUY orders (not yet filled). */
  reserved(currency: string): Money {
    return this.state.reserved.get(currency) ?? Money.zero();
  }

  /**
   * Quote the bot may actually deploy for new BUYs. Deployable = available cash
   * MINUS capital already reserved by in-flight bot BUY orders, so the bot can
   * never spend the same CAD twice. This is the PAPER realm model: it is not
   * aware of exchange-held/frozen funds. For a LIVE position against a real
   * account, use `deployableQuoteBounded`, which caps by the exchange's
   * authoritative available balance.
   */
  deployableQuote(currency: string): Money {
    return this.cash(currency).sub(this.reserved(currency)).isNegativeOrZero()
      ? Money.zero()
      : this.cash(currency).sub(this.reserved(currency));
  }

  /**
   * Deployable quote for `currency`, bounded by the exchange's AUTHORITATIVE
   * available balance (F-7). This is the LIVE realm model.
   *
   * Exchange semantics: `Balance` exposes `total`, `available`, `held`. NDAX
   * reports `amount` = total and `hold` = held, and the adapter derives
   * `available = total - held` (see NdaxAdapter.getBalances). So `available`
   * ALREADY EXCLUDES held/frozen funds — we must never subtract `held` a second
   * time.
   *
   * Formula (no double subtraction):
   *   deployable = min(managedCash, exchangeAvailable) - botReserved
   *
   *   - `exchangeAvailable` (= total - held) bounds by what the exchange can
   *     actually fund (held/frozen funds can never be deployed).
   *   - `managedCash` bounds by the bot's OWN managed quote — it is "the quote
   *     currency available to the bot", never "everything in the exchange
   *     account". Unauthorized/un-tracked deposited quote is not deployable.
   *   - `botReserved` is removed exactly once (in-flight bot orders). It is a
   *     separate internal concept from exchange-held; they never combine.
   *
   * Fail-closed:
   *   - No balance reported                       -> 0 (unknown is never spendable).
   *   - Negative total/available/held             -> 0 (malformed exchange state).
   *   - available > total  (would imply held<0)   -> 0 (inconsistent).
   *   - total - held != available                  -> 0 (inconsistent decomposition).
   *   - reserved >= deployable pool                -> 0.
   *
   * Held/frozen quote therefore never counts as deployable, and a BUY approved
   * with this value can always be funded (exchange available still covers it).
   * It affects ONLY deployable capital — never managed equity/P&L/ownership.
   */
  deployableQuoteBounded(currency: string, balance: Balance | null | undefined): Money {
    if (!Portfolio.isUsableExchangeAvailable(balance)) return Money.zero();
    const managedCash = this.cash(currency);
    const exchangeAvailable = balance.available;
    // pool = min(bot managed cash, exchange available), never negative.
    const pool = managedCash.compareTo(exchangeAvailable) < 0 ? managedCash : exchangeAvailable;
    const net = pool.isNegativeOrZero() ? Money.zero() : pool.sub(this.reserved(currency));
    return net.isNegativeOrZero() ? Money.zero() : net;
  }

  /**
   * True if a balance's available amount is a trustworthy, internally-consistent
   * spendable figure. Any violation is treated as unknown/malformed and fails
   * closed (deployable -> 0). This is conservative: it never guesses a plausible
   * value to mask an exchange-state problem.
   */
  private static isUsableExchangeAvailable(balance: Balance | null | undefined): balance is Balance {
    if (!balance) return false;
    if (balance.total.isNegative() || balance.available.isNegative() || balance.held.isNegative()) return false;
    if (balance.available.compareTo(balance.total) > 0) return false;
    if (!balance.total.sub(balance.held).equals(balance.available)) return false;
    return true;
  }

  /**
   * Reserve quote for an in-flight bot order. Returns a new Portfolio.
   *
   * F-9 invariants:
   *   - A reservation must never make `reserved` negative (reject a negative amount).
   *   - A reservation must never make `reserved > available managed cash`, i.e.
   *     it must not exceed the deployable pool (`deployableQuote`). Allowing it
   *     would create an impossible state; we fail closed by throwing so the caller
   *     cannot proceed with an un-funded order.
   *
   * @throws on a negative amount, or when the reservation would exceed the
   *         current deployable quote for the currency.
   */
  reserveQuote(currency: string, amount: Money): Portfolio {
    if (amount.isZero()) return this;
    if (amount.isNegative()) {
      throw new Error(`Portfolio.reserveQuote: cannot reserve a negative amount (${amount}) for ${currency}`);
    }
    const deployable = this.deployableQuote(currency);
    if (amount.compareTo(deployable) > 0) {
      throw new Error(
        `Portfolio.reserveQuote: reservation ${amount} exceeds deployable quote ${deployable} for ${currency}`,
      );
    }
    const state = this.cloneState();
    state.reserved.set(currency, this.reserved(currency).add(amount));
    return new Portfolio(state);
  }

  /**
   * Release previously-reserved quote. Returns a new Portfolio.
   *
   * F-9 release is exactly-once and cannot over-release:
   *   - A negative release is rejected (fail closed).
   *   - Releasing MORE than is currently reserved is a safe NO-OP (returns this).
   *     This makes a duplicate/double release of the same order idempotent and,
   *     crucially, prevents it from consuming ANOTHER order's reservation (e.g.
   *     reservations A=300, B=200; releasing A twice must not wipe B).
   *   - `reserved` can therefore NEVER go negative, and reserved capital is never
   *     silently made deployable by an incorrect release.
   *
   * @throws on a negative amount.
   */
  releaseQuote(currency: string, amount: Money): Portfolio {
    if (amount.isZero()) return this;
    if (amount.isNegative()) {
      throw new Error(`Portfolio.releaseQuote: cannot release a negative amount (${amount}) for ${currency}`);
    }
    const current = this.reserved(currency);
    // Fail closed: releasing more than is currently reserved cannot be a valid
    // single release; refuse to mutate anything (prevents cross-order corruption).
    if (amount.compareTo(current) > 0) return this;
    const state = this.cloneState();
    state.reserved.set(currency, current.sub(amount));
    return new Portfolio(state);
  }

  // --- Order-linked reservations (Gate 7.1) ---

  /** The order-linked reservation for a logical order, or null. */
  orderReservation(orderId: string): OrderReservation | null {
    return this.state.orderReservations.get(orderId) ?? null;
  }

  /** Read-only view of all order-linked reservations (keyed by order id). */
  orderReservationsView(): ReadonlyMap<string, OrderReservation> {
    return this.state.orderReservations;
  }

  /**
   * Reserve quote for a SPECIFIC logical order and record the order linkage.
   *
   * This wraps the fungible F-9 pool with order identity so a future live
   * lifecycle can consume partial fills and release exactly once per order. It
   * violates NONE of the fungible invariants — the same deployable-cap check is
   * applied (a reservation can never make `reserved > cash`, so `deployableQuote`
   * never goes negative), and it adds to the SAME aggregate `reserved` pool that
   * `deployableQuote` reads. A logical order can have at most ONE reservation for
   * its lifetime (an order may not acquire two independent reservations for the
   * same intended funds): an existing ACTIVE reservation for the order throws.
   *
   * @throws on a non-positive amount, when the order already has a reservation,
   *         or when the amount exceeds the current deployable quote.
   */
  reserveOrder(orderId: string, currency: string, amount: Money): Portfolio {
    if (amount.isZero() || amount.isNegative()) {
      throw new Error(`Portfolio.reserveOrder: amount must be positive (got ${amount})`);
    }
    if (this.state.orderReservations.has(orderId)) {
      throw new Error(
        `Portfolio.reserveOrder: logical order ${orderId} already has a reservation`,
      );
    }
    const deployable = this.deployableQuote(currency);
    if (amount.compareTo(deployable) > 0) {
      throw new Error(
        `Portfolio.reserveOrder: reservation ${amount} exceeds deployable quote ${deployable} for ${currency}`,
      );
    }
    const state = this.cloneState();
    state.reserved.set(currency, this.reserved(currency).add(amount));
    state.orderReservations.set(orderId, {
      orderId,
      currency,
      amount,
      remaining: amount,
      status: 'ACTIVE',
    });
    return new Portfolio(state);
  }

  /**
   * Consume part of an order's reservation (future partial-fill hook, Gate 7.2).
   *
   * Reduces the order's `remaining` amount. It does NOT touch the aggregate
   * `reserved` pool: in the paper realm a fill applies cash via `applyFill` in
   * the same step (Gate 7.2); until then keeping the full committed amount
   * reserved is CONSERVATIVE and never over-states deployable quote, while the
   * per-order `remaining` accurately tracks the unconsumed portion. Exact Money
   * arithmetic; fails closed rather than going negative or crossing an order.
   *
   * @throws if the order has no ACTIVE reservation, or the amount is
   *         non-positive, or it exceeds the remaining reserved amount.
   */
  consumeOrderReservation(orderId: string, amount: Money): Portfolio {
    const res = this.state.orderReservations.get(orderId);
    if (!res || res.status !== 'ACTIVE') {
      throw new Error(`Portfolio.consumeOrderReservation: no active reservation for order ${orderId}`);
    }
    if (amount.isNegativeOrZero()) {
      throw new Error(`Portfolio.consumeOrderReservation: consumption must be positive (got ${amount})`);
    }
    if (amount.compareTo(res.remaining) > 0) {
      throw new Error(
        `Portfolio.consumeOrderReservation: consumption ${amount} exceeds remaining reservation ${res.remaining} for order ${orderId}`,
      );
    }
    const state = this.cloneState();
    const cur = state.orderReservations.get(orderId)!;
    cur.remaining = cur.remaining.sub(amount);
    return new Portfolio(state);
  }

  /**
   * Release the REMAINING unconsumed portion of an order's reservation once the
   * order reaches a terminal outcome (cancel/reject; Gate 7.2 also applies the
   * consumed amount via `applyFill`). Exactly-once and cannot over-release:
   * - If the order has no ACTIVE reservation, this is a safe NO-OP (an already
   *   RELEASED/unknown order releases nothing) — so a double release never
   *   consumes another order's funds.
   * - It releases the current `remaining` (the unused committed amount) back to
   *   the deployable pool; the `remaining` amount is zeroed and the record is
   *   marked RELEASED (the consumed portion stays reserved until Gate 7.2 pairs
   *   `applyFill` with a `reserved` reduction, keeping `deployable` conservative).
   */
  releaseOrderReservation(orderId: string): Portfolio {
    const res = this.state.orderReservations.get(orderId);
    if (!res || res.status !== 'ACTIVE') return this;
    const state = this.cloneState();
    const cur = state.orderReservations.get(orderId)!;
    const releasing = cur.remaining;
    state.reserved.set(cur.currency, this.reserved(cur.currency).sub(releasing));
    cur.remaining = Money.zero();
    cur.status = 'RELEASED';
    return new Portfolio(state);
  }

  // --- Managed-position introspection ---

  /** Number of symbols the bot currently manages (quantity > 0). External-only assets do NOT count. */
  managedOpenCount(): number {
    let n = 0;
    for (const p of this.state.positions.values()) if (p.quantity.isPositive()) n += 1;
    return n;
  }

  /**
   * Expected EXCHANGE available balance per BASE asset, derived from the bot's
   * own bookkeeping (managed + external). Used for ownership-aware reconciliation:
   * the bot asserts the exchange should show this much of each asset it accounts
   * for. A mismatch (exchange shows more/less) signals a deposit, withdrawal, or
   * manual user trade — surfaced as a discrepancy, never auto-adopted. Quote
   * currency is deliberately excluded (its availability is enforced separately).
   */
  expectedAssetBalances(): Map<string, Money> {
    const expected = new Map<string, Money>();
    for (const pos of this.state.positions.values()) {
      const base = pos.symbol.split('/')[0] ?? pos.symbol;
      expected.set(base, (expected.get(base) ?? Money.zero()).add(pos.quantity));
    }
    for (const [symbolOrBase, amount] of this.state.externalSnapshot) {
      const base = symbolOrBase.split('/')[0] ?? symbolOrBase;
      expected.set(base, (expected.get(base) ?? Money.zero()).add(amount));
    }
    return expected;
  }

  /**
   * Is the managed portfolio at its maximum number of open positions? Used by the
   * coordinator / risk to block new entries. External holdings are irrelevant.
   */
  atMaxOpenPositions(maxOpenPositions: number): boolean {
    if (maxOpenPositions <= 0) return false; // 0 means "no limit" in our config semantics
    return this.managedOpenCount() >= maxOpenPositions;
  }

  /** Total equity = cash + market value of all positions (quote-denominated). */
  static equityOf(m: Pick<PortfolioModel, 'cash' | 'positions'>): Money {
    let total = Money.zero();
    for (const amount of m.cash.values()) total = total.add(amount);
    for (const pos of m.positions.values()) {
      total = total.add(pos.costBasis); // positions carried at cost for baseline equity
    }
    return total;
  }

  /**
   * Apply a fill to the portfolio.
   *
   * @param symbol        e.g. "BTC/CAD"
   * @param side          BUY or SELL
   * @param quantity      filled base quantity (must be > 0)
   * @param price         fill price (quote per base unit)
   * @param fee           fee in quote currency
   * @returns the updated portfolio (new instance)
   */
  applyFill(symbol: string, side: OrderSide, quantity: Money, price: Money, fee: Money): Portfolio {
    const quote = symbol.split('/')[1]!;

    if (!quantity.isPositive()) {
      throw new Error('Portfolio.applyFill: fill quantity must be positive');
    }

    const state = this.cloneState();
    const notional = quantity.mul(price);

    if (side === 'BUY') {
      const cost = notional.add(fee);
      const existing = state.positions.get(symbol);
      if (existing) {
        const newQty = existing.quantity.add(quantity);
        const newCostBasis = existing.costBasis.add(cost);
        const sq = Portfolio.sourceBreakdownOf(existing);
        state.positions.set(symbol, {
          ...existing,
          quantity: newQty,
          costBasis: newCostBasis,
          averageEntryPrice: newCostBasis.div(newQty),
          feesPaid: existing.feesPaid.add(fee),
          sourceQuantities: { BOT: sq.BOT.add(quantity), EXTERNAL_AUTHORIZED: sq.EXTERNAL_AUTHORIZED },
        });
      } else {
        state.positions.set(symbol, {
          symbol,
          quantity,
          costBasis: cost,
          averageEntryPrice: cost.div(quantity),
          realizedPnl: Money.zero(),
          feesPaid: fee,
          source: 'BOT',
          sourceQuantities: { BOT: quantity, EXTERNAL_AUTHORIZED: Money.zero() },
        });
      }
      state.cash.set(quote, state.cash.get(quote)!.sub(cost));
      state.totalFees = state.totalFees.add(fee);
    } else {
      // SELL — reduce/close a long position.
      const existing = state.positions.get(symbol);
      if (!existing || existing.quantity.isZero()) {
        throw new Error('Portfolio.applyFill: SELL with no held position');
      }
      if (quantity.compareTo(existing.quantity) > 0) {
        throw new Error('Portfolio.applyFill: SELL quantity exceeds held position (cannot go short)');
      }
      const proceeds = notional.sub(fee);
      const realized = quantity.mul(price.sub(existing.averageEntryPrice)).sub(fee);
      const remainingQty = existing.quantity.sub(quantity);
      const remainingCostBasis = remainingQty.isZero()
        ? Money.zero()
        : existing.costBasis.sub(existing.averageEntryPrice.mul(quantity));

      // Reduce the provenance breakdown deterministically, consuming BOT
      // inventory first then EXTERNAL_AUTHORIZED, so the per-source quantities
      // always sum EXACTLY to the remaining aggregate quantity (no drift). The
      // SELL is fungible across sources (both are bot-managed once authorized),
      // so this is pure provenance bookkeeping; P&L uses average-cost basis.
      const sq = Portfolio.sourceBreakdownOf(existing);
      let sellRemaining = quantity;
      const botConsumed = Money.min(sq.BOT, sellRemaining);
      sellRemaining = sellRemaining.sub(botConsumed);
      const extConsumed = Money.min(sq.EXTERNAL_AUTHORIZED, sellRemaining);

      state.positions.set(symbol, {
        ...existing,
        quantity: remainingQty,
        costBasis: remainingCostBasis,
        realizedPnl: existing.realizedPnl.add(realized),
        feesPaid: existing.feesPaid.add(fee),
        sourceQuantities: {
          BOT: sq.BOT.sub(botConsumed),
          EXTERNAL_AUTHORIZED: sq.EXTERNAL_AUTHORIZED.sub(extConsumed),
        },
      });
      if (state.positions.get(symbol)!.quantity.isZero()) {
        state.positions.delete(symbol);
      }
      state.cash.set(quote, state.cash.get(quote)!.add(proceeds));
      state.realizedPnl = state.realizedPnl.add(realized);
      state.totalFees = state.totalFees.add(fee);
    }

    // Track peak equity (cost-basis baseline) for drawdown.
    const equity = Portfolio.equityOf(state);
    if (equity.compareTo(state.peakEquity) > 0) {
      state.peakEquity = equity;
    }

    return new Portfolio(state);
  }

  // --- Idempotent live fill accounting (Gate 7.2) ---

  /**
   * An execution identity already applied, or null.
   */
  appliedExecution(executionId: string): AppliedExecution | null {
    return this.state.appliedExecutions.get(executionId) ?? null;
  }

  /**
   * Read-only count of applied executions (idempotency ledger size).
   */
  appliedCount(): number {
    return this.state.appliedExecutions.size;
  }

  /**
   * Apply ONE exchange execution to the Portfolio at most once.
   *
   * This is the live idempotent accounting primitive. The deduplication key is
   * the execution identity (`fill.executionId`), NOT the order id and NOT the
   * order status — an order may fill many times, and `FILLED`/`PARTIALLY_FILLED`
   * never identify which execution was already processed. A live fill without a
   * trustworthy execution identity is REFUSED (fail closed): a locally
   * constructed identity from price/quantity/timestamp does not prove exchange
   * uniqueness, and silently applying it risks double-accounting.
   *
   * On a repeat observation of an already-applied execution (same identity):
   *   - identical payload  -> returns THIS (no Portfolio mutation, exactly once).
   *   - conflicting payload / different order -> THROWS (fail closed; flag for
   *     reconciliation). It is never silently treated as a brand-new fill.
   *
   * Ordering is chosen for crash-safety under the portfolio store's single-file
   * atomic write: the fill accounting (`applyFill`), the BUY reservation
   * consumption, and the "applied" marker all land in ONE returned Portfolio
   * model, so they are persisted together (there is no window where a fill is
   * accounted but not marked, or marked but not accounted). The order/fill
   * observation ledger (OrderStore) is a separate file: a duplicate observation
   * there is detected and ignored here.
   *
   * @throws when `fill.executionId` is absent/empty, or on a conflicting
   *         observation, or when the underlying accounting is invalid (e.g. a
   *         SELL larger than the held position), or (BUY) when an existing
   *         active reservation lacks the fill's cost.
   */
  applyLiveFill(orderId: string, symbol: string, side: OrderSide, fill: Fill): Portfolio {
    const executionId = fill.executionId ?? null;
    if (!executionId) {
      throw new Error(
        `Portfolio.applyLiveFill: fill for order ${orderId} has no executionId; ` +
          'a fill without a trustworthy identity cannot be applied idempotently',
      );
    }
    // A non-zero fee may ONLY be accounted when its currency is authoritatively
    // quote. A base/unknown/third-asset fee is NEVER silently added/subtracted
    // as if it were quote (that would corrupt cash/proceeds). Zero fees are
    // currency-agnostic and allowed.
    if (!fill.fee.isZero() && fill.feeCurrency !== 'quote') {
      throw new Error(
        `Portfolio.applyLiveFill: fill for order ${orderId} has a non-zero fee (${fill.fee}) in a ` +
          `non-quote currency (${fill.feeCurrency}); refusing to account a fee whose currency is not ` +
          'authoritatively quote (fail closed)',
      );
    }
    const existing = this.state.appliedExecutions.get(executionId);
    if (existing) {
      this.assertSameExecution(existing, orderId, symbol, side, fill);
      return this; // already applied exactly once — do not mutate again
    }

    const cost = fill.quantity.mul(fill.price).add(fill.fee);
    let next = this.applyFill(symbol, side, fill.quantity, fill.price, fill.fee);
    if (side === 'BUY') {
      const res = next.stateModel.orderReservations.get(orderId);
      if (res && res.status === 'ACTIVE') {
        // Pair the cash reduction (applyFill) with a reservation reduction:
        // `consumeOrderReservation` lowers the per-order `remaining` and
        // `releaseQuote` lowers the aggregate `reserved` pool, so the deployed
        // quote (`cash - reserved`) stays correct and the same fill can never
        // consume or release the reservation twice.
        next = next.consumeOrderReservation(orderId, cost);
        next = next.releaseQuote(res.currency, cost);
      }
    }
    return next.recordAppliedExecution(orderId, symbol, side, fill);
  }

  /**
   * Reject a conflicting observation of an already-applied execution: the same
   * execution identity must map to the same order and the same exact economic
   * payload (exact Money). A mismatch means the exchange state or our ledger is
   * inconsistent; we fail closed rather than silently re-accounting.
   */
  private assertSameExecution(existing: AppliedExecution, orderId: string, symbol: string, side: OrderSide, fill: Fill): void {
    if (existing.orderId !== orderId) {
      throw new Error(
        `Portfolio.applyLiveFill: execution ${fill.executionId} was already applied to order ` +
          `${existing.orderId}, but is being observed against order ${orderId}`,
      );
    }
    if (existing.symbol !== symbol || existing.side !== side) {
      throw new Error(
        `Portfolio.applyLiveFill: execution ${fill.executionId} has a different symbol/side than what was applied`,
      );
    }
    if (
      !existing.quantity.equals(fill.quantity) ||
      !existing.price.equals(fill.price) ||
      !existing.fee.equals(fill.fee)
    ) {
      throw new Error(
        `Portfolio.applyLiveFill: execution ${fill.executionId} conflicts with the applied payload ` +
          '(quantity/price/fee mismatch); flag for reconciliation, do not re-apply',
      );
    }
  }

  /** Record an execution identity as applied (single atomic clone). */
  private recordAppliedExecution(orderId: string, symbol: string, side: OrderSide, fill: Fill): Portfolio {
    const state = this.cloneState();
    state.appliedExecutions.set(fill.executionId!, {
      orderId,
      symbol,
      side,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee,
    });
    return new Portfolio(state);
  }

  // --- Order-level MANUAL accounting (Gate 9) — deliberately separate from the
  //     per-execution live path above. ---

  /** The manual settlement for a manual intent, or null. */
  manualSettlement(intentId: string): ManualSettlement | null {
    return (this.state.manualSettlements ?? new Map()).get(intentId) ?? null;
  }

  /** Read-only view of manual settlements (keyed by manual intent id). */
  manualSettlementsView(): ReadonlyMap<string, ManualSettlement> {
    return this.state.manualSettlements ?? new Map();
  }

  /** The live-order attestation for a live order, or null. */
  liveOrderAttestation(clientOrderId: string): LiveOrderAttestation | null {
    return (this.state.liveOrderAttestations ?? new Map()).get(clientOrderId) ?? null;
  }

  /** Read-only view of live-order attestations (keyed by live clientOrderId). */
  liveOrderAttestationsView(): ReadonlyMap<string, LiveOrderAttestation> {
    return this.state.liveOrderAttestations ?? new Map();
  }

  /**
   * Apply ONE order-level manual settlement at most once.
   *
   * This is the Gate 9 manual-execution accounting primitive. It is FUNDAMENTALLY
   * DIFFERENT from `applyLiveFill`:
   *  - Dedup key is the MANUAL INTENT id (a local logical idempotency key), NOT an
   *    execution identity. It is NOT `fill.executionId` and it is NOT an exchange
   *    `OrderId`.
   *  - It accounts the ORDER AGGREGATE (final filled quantity x average price +
   *    total fee) once — it does NOT attempt per-fill decomposition, so it does
   *    NOT require (or fabricate) an execution identity. It claims only: "this
   *    operator-executed order, as a whole, filled this final aggregate."
   *  - It NEVER goes through `applyLiveFill`, so it can never bypass the
   *    execution-identity requirement of the per-fill live path.
   *
   * Idempotency & conflict handling (fail closed):
   *  - A repeat of the SAME settlement (same intentId + identical payload) is a
   *    no-op (returns this) — exactly once, never double-accounted.
   *  - A CONFLICTING repeat (same intentId but a different
   *    quantity/price/fee/symbol/side) THROWS: it is never treated as a brand-new
   *    settlement. This is the manual-adjustment-level idempotency guard that
   *    does not rely on the operator "not clicking twice".
   *
   * Reservation handling (BUY): a BUY settlement REQUIRES an ACTIVE order-linked
   * reservation keyed by the intent id (fail closed — a manual BUY was reserved
   * at proposal; without it the fill would silently consume un-reserved cash and
   * double-deploy the same quote). The actual aggregate cost must not exceed the
   * reserved amount (under-reservation fails closed; the reservation is never
   * over-consumed). Once the order is terminal the reservation is released
   * EXACTLY ONCE: the consumed cost stays as the cash reduction, and the leftover
   * (reserved − cost) is freed back to the deployable pool. Nothing mutates on a
   * thrown path (the caller persists only this returned model).
   *
   * @throws on a missing/empty intentId, a conflicting repeat, an invalid
   *         quantity/price/fee (negative; a BUY must be positive), a BUY with no
   *         active reservation, an under-reserved BUY, or an invalid SELL
   *         (exceeds held position).
   */
  settleManualOrder(op: {
    intentId: string;
    symbol: string;
    side: OrderSide;
    quantity: Money;
    price: Money;
    fee: Money;
    orderId: string | null;
    evidenceSource: string;
    exchangedValidated: boolean;
    /**
     * The accounting authority that dictated the numbers. `'exchange_validated'`
     * = used authoritative exchange evidence; `'operator_attested'` = relies on
     * operator attestation for intent-to-order attribution. It is NEVER a
     * provenance proof.
     */
    settlementMode: 'exchange_validated' | 'operator_attested';
    /**
     * ALWAYS `false` (literal type). This settlement is operator-attested +
     * exchange-consistent accounting; it is never exchange-proven provenance.
     */
    provenanceProof: false;
    operatorConfirmedBy: string | null;
    executedAtMs: number | null;
  }): Portfolio {
    if (!op.intentId) {
      throw new Error('Portfolio.settleManualOrder: intentId is required (manual settlement identity)');
    }
    if (op.quantity.isNegativeOrZero()) {
      throw new Error('Portfolio.settleManualOrder: manual settlement quantity must be positive');
    }
    if (op.price.isNegative()) {
      throw new Error('Portfolio.settleManualOrder: manual settlement price must not be negative');
    }
    if (op.fee.isNegative()) {
      throw new Error('Portfolio.settleManualOrder: manual settlement fee must not be negative');
    }

    const existing = (this.state.manualSettlements ?? new Map()).get(op.intentId);
    if (existing) {
      if (
        existing.symbol !== op.symbol ||
        existing.side !== op.side ||
        !existing.quantity.equals(op.quantity) ||
        !existing.price.equals(op.price) ||
        !existing.fee.equals(op.fee) ||
        !Portfolio.sameExternalOrderId(existing.orderId, op.orderId) ||
        existing.settlementMode !== op.settlementMode
      ) {
        throw new Error(
          `Portfolio.settleManualOrder: intent ${op.intentId} is already settled with a different payload; ` +
            'flag for reconciliation, do not re-settle',
        );
      }
      return this; // identical repeat => exactly once, no mutation
    }

    // CROSS-INTENT DUPLICATE-ORDER GUARD: one external exchange OrderId must never
    // be accounted by more than ONE intent. A real order is one fill (or one
    // zero-fill terminal). If a DIFFERENT intent already recorded a manual
    // settlement for this external OrderId, accounting it again would
    // double-count the same real execution (e.g. inflate a position by 2x).
    // OrderIds are compared by their integer value (NDAX queries them via
    // `Number`), so a representation difference like a leading zero cannot
    // sidestep the guard. This check runs BEFORE any mutation, so the rejected
    // settlement never touches cash/position/reservation. (The same-intentId
    // case above is covered separately by idempotency.)
    if (op.orderId !== null) {
      for (const [otherIntentId, s] of this.state.manualSettlements ?? new Map()) {
        if (otherIntentId !== op.intentId && Portfolio.sameExternalOrderId(s.orderId, op.orderId)) {
          throw new Error(
            `Portfolio.settleManualOrder: external order ${op.orderId} is already accounted by a different intent ` +
              `${otherIntentId}; refusing to account the same exchange order twice (duplicate accounting)`,
          );
        }
      }
    }

    const cost = op.quantity.mul(op.price).add(op.fee);

    // BUY settlement MUST be matched to an ACTIVE order-linked reservation. A
    // manual BUY reserves quote at proposal; an unreserved BUY would silently
    // consume cash without ever bounding the deployable pool (double-deploy).
    // This must be checked BEFORE any accounting so a failure cannot partially
    // mutate (nothing of `next` is ever persisted on a throw).
    const reservation = (this.state.orderReservations ?? new Map()).get(op.intentId);
    if (op.side === 'BUY') {
      if (!reservation || reservation.status !== 'ACTIVE') {
        throw new Error(
          `Portfolio.settleManualOrder: manual BUY ${op.intentId} has no active reservation; ` +
            'failed closed (an unreserved manual BUY settlement is not permitted)',
        );
      }
      if (cost.compareTo(reservation.remaining) > 0) {
        throw new Error(
          `Portfolio.settleManualOrder: manual BUY ${op.intentId} cost ${cost} exceeds reserved ` +
            `remaining ${reservation.remaining} (under-reserved; fail closed, never over-consumed)`,
        );
      }
    }

    // Apply the order-aggregate fill via the non-idempotent accounting path.
    let next = this.applyFill(op.symbol, op.side, op.quantity, op.price, op.fee);
    if (op.side === 'BUY') {
      // Pair the cash reduction with the reservation consumption + release so the
      // deployed quote (`cash - reserved`) stays correct, then release the
      // TERMINAL reservation exactly once so the leftover returns to deployable.
      next = next.consumeOrderReservation(op.intentId, cost);
      next = next.releaseQuote(reservation!.currency, cost);
      next = next.releaseOrderReservation(op.intentId);
    }
    const state = next.cloneState();
    state.manualSettlements.set(op.intentId, {
      intentId: op.intentId,
      orderId: op.orderId,
      symbol: op.symbol,
      side: op.side,
      quantity: op.quantity,
      price: op.price,
      fee: op.fee,
      evidenceSource: op.evidenceSource,
      exchangedValidated: op.exchangedValidated,
      settlementMode: op.settlementMode,
      provenanceProof: op.provenanceProof,
      operatorConfirmedBy: op.operatorConfirmedBy,
      executedAtMs: op.executedAtMs,
      createdAtMs: Date.now(),
    });
    return new Portfolio(state);
  }

  /**
   * Apply ONE operator-attested live-order resolution at most once.
   *
   * This is the operator-attested accounting path for an ambiguous controlled-
   * LIVE order (a RETRAC-SUBMITTED order that is exchange-FILLED but whose
   * execution set cannot be proven complete). It is FUNDAMENTALLY DIFFERENT from
   * `applyLiveFill` (per-execution, exchange-proven) and from `settleManualOrder`
   * (an operator-EXECUTED external order):
   *  - It is keyed by the live order's durable local `clientOrderId`.
   *  - It accounts the ORDER AGGREGATE (attested filled quantity x attested
   *    average execution price + fee) once — it does NOT fabricate an execution
   *    identity, and it is NEVER recorded in `appliedExecutions` as if it were an
   *    NDAX execution id.
   *  - `provenanceProof` is ALWAYS `false`: operator attestation is never
   *    exchange-proven provenance, and execution completeness is NOT proven.
   *  - The attested numbers must come from fresh READ-ONLY exchange evidence
   *    (`evidenceSource = 'exchange_read'`); they are not operator-typed values.
   *
   * Fail-closed accounting invariants:
   *  - attested filled quantity must be positive and never exceed the original
   *    order quantity;
   *  - attested average price must be positive;
   *  - a fee must be zero (currency-agnostic) OR authoritatively quote; a non-zero
   *    base/third/unknown fee is NEVER silently converted to quote;
   *  - only the attributable proceeds (quantity x averagePrice - fee) are booked;
   *    the residual exchange balance is NEVER adopted as order proceeds;
   *  - the SELL consumes the position provenance via `applyFill` (BOT first), and
   *    a BUY requires an ACTIVE order-linked reservation (never consumes
   *    un-reserved cash).
   *
   * Idempotency & conflict handling (fail closed):
   *  - A repeat of the SAME attestation (same clientOrderId + identical payload)
   *    is a no-op (returns this) — exactly once, never double-accounted.
   *  - A CONFLICTING repeat (same clientOrderId but a different
   *    quantity/price/fee/symbol/side/exchangeOrderId) THROWS.
   *  - A different live order already attesting the SAME exchange OrderId, or a
   *    manual settlement for the same external OrderId, or an applied execution
   *    already on this order => THROWS (duplicate-accounting guard).
   *
   * @throws on a missing/empty identity, a conflicting repeat, an invalid
   *         quantity/price/fee, a duplicate exchange-order accounting, or an
   *         invalid BUY (no active reservation / under-reserved / exceeds held).
   */
  settleLiveOrderAttested(op: {
    clientOrderId: string;
    symbol: string;
    side: OrderSide;
    /** The original order quantity (the attested fill must never exceed it). */
    orderQuantity: Money;
    exchangeOrderId: string;
    exchangeStatus: string;
    attestedFilledQuantity: Money;
    attestedAveragePrice: Money;
    fee: Money;
    feeCurrency: FeeCurrency;
    evidenceSource: string;
    accountingAuthority: string;
    provenanceProof: false;
    operatorConfirmedBy: string;
    attestedAtMs: number;
    exchangeReadAtMs: number;
    exchangeEvidence: ExchangeEvidenceSnapshot;
  }): Portfolio {
    const { clientOrderId, symbol, side, orderQuantity, exchangeOrderId, attestedFilledQuantity, attestedAveragePrice } = op;
    if (!clientOrderId) {
      throw new Error('Portfolio.settleLiveOrderAttested: clientOrderId is required (live-order attestation identity)');
    }
    if (!exchangeOrderId) {
      throw new Error('Portfolio.settleLiveOrderAttested: exchangeOrderId is required (must match the persisted live order)');
    }
    if (!symbol || (side !== 'BUY' && side !== 'SELL')) {
      throw new Error('Portfolio.settleLiveOrderAttested: symbol and a valid side are required');
    }
    if (!attestedFilledQuantity.isPositive()) {
      throw new Error('Portfolio.settleLiveOrderAttested: attested filled quantity must be positive');
    }
    if (attestedFilledQuantity.compareTo(orderQuantity) > 0) {
      throw new Error(
        `Portfolio.settleLiveOrderAttested: attested filled quantity ${attestedFilledQuantity} exceeds the original order quantity ${orderQuantity}`,
      );
    }
    if (!attestedAveragePrice.isPositive()) {
      throw new Error('Portfolio.settleLiveOrderAttested: attested average price must be positive');
    }
    if (op.fee.isNegative()) {
      throw new Error('Portfolio.settleLiveOrderAttested: fee must not be negative');
    }
    // A non-zero fee may ONLY be accounted when its currency is authoritatively
    // quote (or zero, currency-agnostic). A base/third/unknown fee is NEVER
    // silently converted to quote (that would corrupt proceeds).
    if (!op.fee.isZero() && op.feeCurrency !== 'quote') {
      throw new Error(
        `Portfolio.settleLiveOrderAttested: live order ${clientOrderId} has a non-zero fee (${op.fee}) in a ` +
          `non-quote currency (${op.feeCurrency}); refusing to account a fee whose currency is not ` +
          'authoritatively quote (fail closed)',
      );
    }
    if (op.provenanceProof !== false) {
      throw new Error('Portfolio.settleLiveOrderAttested: provenanceProof must always be false (operator attestation is never exchange proof)');
    }
    // Defense-in-depth: the accounting authority is enforced HERE, not only by the
    // CLI parser. Only operator attestation may drive this path; a mislabelled
    // attestation is never allowed to settle an order.
    if (op.accountingAuthority !== 'operator_attestation') {
      throw new Error(
        `Portfolio.settleLiveOrderAttested: accountingAuthority must be "operator_attestation" (got "${String(op.accountingAuthority)}"); fail closed`,
      );
    }

    // Idempotency: a repeat of the identical attestation is a no-op; a conflicting
    // repeat is a fail-closed reconciliation signal (never a second accounting).
    const existing = (this.state.liveOrderAttestations ?? new Map()).get(clientOrderId);
    if (existing) {
      if (
        existing.exchangeEvidence.symbol === symbol &&
        existing.exchangeEvidence.side === side &&
        existing.exchangeOrderId === exchangeOrderId &&
        existing.attestedFilledQuantity.equals(attestedFilledQuantity) &&
        existing.attestedAveragePrice.equals(attestedAveragePrice) &&
        existing.fee.equals(op.fee)
      ) {
        return this; // identical repeat => exactly once, no mutation
      }
      throw new Error(
        `Portfolio.settleLiveOrderAttested: live order ${clientOrderId} is already attested with a different payload; ` +
          'flag for reconciliation, do not re-account',
      );
    }

    // DUPLICATE-ACCOUNTING GUARD: the same real exchange order must never be
    // accounted twice.
    //  - A proven execution already applied to THIS order (appliedExecutions)
    //    means the order's execution was already accounted on the per-execution
    //    path; attesting the aggregate would double-count.
    for (const [, a] of this.state.appliedExecutions ?? new Map()) {
      if (a.orderId === clientOrderId) {
        throw new Error(
          `Portfolio.settleLiveOrderAttested: live order ${clientOrderId} already has an applied execution; ` +
            'refusing to also attest the order aggregate (duplicate accounting)',
        );
      }
    }
    //  - A manual settlement already accounting this external OrderId.
    for (const [otherIntentId, s] of this.state.manualSettlements ?? new Map()) {
      if (Portfolio.sameExternalOrderId(s.orderId, exchangeOrderId)) {
        throw new Error(
          `Portfolio.settleLiveOrderAttested: exchange order ${exchangeOrderId} is already accounted by a manual ` +
            `settlement ${otherIntentId}; refusing to account the same exchange order twice`,
        );
      }
    }
    //  - Another live order already attesting this external OrderId.
    for (const [otherClientOrderId, other] of this.state.liveOrderAttestations ?? new Map()) {
      if (otherClientOrderId !== clientOrderId && Portfolio.sameExternalOrderId(other.exchangeOrderId, exchangeOrderId)) {
        throw new Error(
          `Portfolio.settleLiveOrderAttested: exchange order ${exchangeOrderId} is already attested by a different ` +
            `live order ${otherClientOrderId}; refusing to account the same exchange order twice`,
        );
      }
    }

    // BUY settlement MUST be matched to an ACTIVE order-linked reservation (a live
    // BUY reserves quote at submission; an unreserved BUY would silently consume
    // cash without bounding the deployable pool).
    const cost = attestedFilledQuantity.mul(attestedAveragePrice).add(op.fee);
    const reservation = (this.state.orderReservations ?? new Map()).get(clientOrderId);
    if (side === 'BUY') {
      if (!reservation || reservation.status !== 'ACTIVE') {
        throw new Error(
          `Portfolio.settleLiveOrderAttested: live BUY ${clientOrderId} has no active reservation; ` +
            'failed closed (an unreserved BUY attestation is not permitted)',
        );
      }
      if (cost.compareTo(reservation.remaining) > 0) {
        throw new Error(
          `Portfolio.settleLiveOrderAttested: live BUY ${clientOrderId} cost ${cost} exceeds reserved ` +
            `remaining ${reservation.remaining} (under-reserved; fail closed, never over-consumed)`,
        );
      }
    }

    // Apply the order-aggregate fill via the shared accounting path (correct SELL
    // provenance consumption, cash/proceeds, realized P&L and fees). Do NOT
    // duplicate the SELL accounting math here.
    let next = this.applyFill(symbol, side, attestedFilledQuantity, attestedAveragePrice, op.fee);
    if (side === 'BUY') {
      next = next.consumeOrderReservation(clientOrderId, cost);
      next = next.releaseQuote(reservation!.currency, cost);
      next = next.releaseOrderReservation(clientOrderId);
    }

    const state = next.cloneState();
    state.liveOrderAttestations.set(clientOrderId, {
      attestationId: `op-attest:${clientOrderId}`,
      clientOrderId,
      exchangeOrderId,
      exchangeStatus: op.exchangeStatus,
      attestedFilledQuantity,
      attestedAveragePrice,
      fee: op.fee,
      feeCurrency: op.fee.isZero() ? 'quote' : op.feeCurrency,
      evidenceSource: op.evidenceSource,
      accountingAuthority: op.accountingAuthority,
      provenanceProof: op.provenanceProof,
      operatorConfirmedBy: op.operatorConfirmedBy,
      attestedAtMs: op.attestedAtMs,
      exchangeReadAtMs: op.exchangeReadAtMs,
      exchangeEvidence: op.exchangeEvidence,
    });
    return new Portfolio(state);
  }

  /**
   * Recompute equity/unrealized P&L using a current market price per symbol.
   * Returns current equity and unrealized P&L (quote) for open positions.
   */
  markToMarket(prices: Map<string, Money>): { equity: Money; unrealizedPnl: Money } {
    let equity = Money.zero();
    for (const amount of this.state.cash.values()) equity = equity.add(amount);
    let unrealized = Money.zero();
    for (const pos of this.state.positions.values()) {
      const price = prices.get(pos.symbol);
      if (!price) continue; // cannot mark this symbol
      const mv = pos.quantity.mul(price);
      equity = equity.add(mv);
      unrealized = unrealized.add(pos.quantity.mul(price.sub(pos.averageEntryPrice)));
    }
    return { equity, unrealizedPnl: unrealized };
  }

  /** Sum notional market value of all open positions (quote) given prices. */
  exposure(prices: Map<string, Money>): Money {
    let total = Money.zero();
    for (const pos of this.state.positions.values()) {
      const price = prices.get(pos.symbol);
      if (price) total = total.add(pos.quantity.mul(price));
    }
    return total;
  }

  /**
   * Whether two external order-id values denote the SAME exchange order.
   *
   * NDAX order ids are integers: the adapter queries them as `Number(orderId)`,
   * so any all-digits representation of the same integer value — e.g. a leading
   * zero like `0999001` vs `999001` — is THE SAME order. Comparing raw strings
   * would let such a representation difference slip past the duplicate-order
   * guard and account one real fill under two intents. So a digit-string order
   * id is compared numerically (exact `BigInt`, so no float precision loss can
   * conflate genuinely distinct large integers); a non-numeric or otherwise
   * non-equal id falls back to strict string equality (never weaker than before).
   * `null` only equals `null`.
   */
  static sameExternalOrderId(a: string | null, b: string | null): boolean {
    if (a === null || b === null) return a === b;
    if (a === b) return true;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      try {
        return BigInt(a) === BigInt(b);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Resolve a position's provenance breakdown, deriving it (in a backward
   * compatible way) from `source` when a legacy model lacks `sourceQuantities`.
   * The result always sums to `pos.quantity`.
   */
  private static sourceBreakdownOf(pos: PaperPosition): SourceQuantities {
    if (pos.sourceQuantities) {
      return {
        BOT: pos.sourceQuantities.BOT ?? Money.zero(),
        EXTERNAL_AUTHORIZED: pos.sourceQuantities.EXTERNAL_AUTHORIZED ?? Money.zero(),
      };
    }
    return {
      BOT: pos.source === 'BOT' ? pos.quantity : Money.zero(),
      EXTERNAL_AUTHORIZED: pos.source === 'EXTERNAL_AUTHORIZED' ? pos.quantity : Money.zero(),
    };
  }

  /**
   * Produce the new provenance breakdown after adding `added` base units of
   * explicitly-authorized external inventory onto an existing managed position.
   * Existing BOT provenance is preserved (never reclassified); the external
   * amount is added to the EXTERNAL_AUTHORIZED component.
   */
  private static mergeExternalBreakdown(managed: PaperPosition, added: Money): SourceQuantities {
    const sq = Portfolio.sourceBreakdownOf(managed);
    return {
      BOT: sq.BOT,
      EXTERNAL_AUTHORIZED: sq.EXTERNAL_AUTHORIZED.add(added),
    };
  }

  private cloneState(): PortfolioModel {
    return {
      cash: new Map(this.state.cash),
      positions: new Map(
        [...this.state.positions].map(([k, p]) => [k, { ...p }]),
      ),
      peakEquity: this.state.peakEquity,
      realizedPnl: this.state.realizedPnl,
      totalFees: this.state.totalFees,
      externalSnapshot: new Map(this.state.externalSnapshot),
      authorizedExternal: new Set(this.state.authorizedExternal),
      reserved: new Map(this.state.reserved),
      orderReservations: new Map(
        [...(this.state.orderReservations ?? [])].map(([id, r]) => [
          id,
          { ...r },
        ]),
      ),
      appliedExecutions: new Map(
        [...(this.state.appliedExecutions ?? [])].map(([execId, a]) => [
          execId,
          { ...a },
        ]),
      ),
      manualSettlements: new Map(
        [...(this.state.manualSettlements ?? [])].map(([id, s]) => [
          id,
          { ...s },
        ]),
      ),
      liveOrderAttestations: new Map(
        [...(this.state.liveOrderAttestations ?? [])].map(([id, a]) => [
          id,
          { ...a, exchangeEvidence: { ...a.exchangeEvidence, observedAccountTrades: a.exchangeEvidence.observedAccountTrades.map((t) => ({ ...t })), observedBalances: a.exchangeEvidence.observedBalances.map((b) => ({ ...b })) } },
        ]),
      ),
    };
  }
}
