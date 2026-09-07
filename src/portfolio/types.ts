/**
 * Portfolio domain types.
 *
 * The portfolio tracks cash, open positions (with average entry price, cost
 * basis, and per-position realized P&L), aggregate realized P&L and fees, and
 * the peak equity used for drawdown. Everything is `Money` (fixed-point BigInt)
 * — no floating-point financial math.
 */

import type { Money } from '../money/Money.js';

/**
 * Where a managed position came from.
 * - `BOT`: created by the bot after the user authorized it to manage/trade.
 * - `EXTERNAL_AUTHORIZED`: an asset that existed before onboarding and which the
 *   user explicitly allowed the bot to manage. It is bot-managed (tradable) but
 *   was not created by the bot.
 */
export type PositionSource = 'BOT' | 'EXTERNAL_AUTHORIZED';

/**
 * Provenance breakdown of a position's aggregate `quantity` by source.
 *
 * A single managed position may legitimately contain a mixture of BOT-created
 * and externally-authorized inventory (a user can authorize external BTC while
 * the bot already holds a BOT-managed BTC position). `source` carries the
 * position's coarse identity, but `sourceQuantities` preserves the exact
 * provenance so BOT inventory is never silently reclassified as
 * EXTERNAL_AUTHORIZED (or vice-versa) during an explicit authorization.
 *
 * Invariant: `BOT + EXTERNAL_AUTHORIZED === quantity` for every position,
 * maintained by `Portfolio.applyFill` and `Portfolio.authorizeExternal`.
 */
export type SourceQuantities = Record<PositionSource, Money>;

/**
 * Lifecycle of an order-linked reservation.
 * - `ACTIVE`: funds are committed to a live (in-flight) order.
 * - `RELEASED`: the order reached a terminal outcome and the unconsumed
 *   remainder was released back to the deployable pool.
 */
export type ReservationStatus = 'ACTIVE' | 'RELEASED';

/**
 * An order-linked quote reservation (Gate 7.1).
 *
 * This is distinct from the fungible `reserved` pool: it associates a precise
 * amount of quote currency with ONE logical order, so a future live-lifecycle
 * (Gate 7.2 fill consumption, Gate 7.3 recovery) can account for partial fills
 * and release exactly once, without accidentally consuming another order's
 * funds. It is keyed by the logical order id (one active reservation per order).
 *
 * A reservation means the funds are unavailable for other orders; it does NOT
 * mean the exchange has filled the order (that is applied by Gate 7.2 via
 * `applyFill`, which pairs each consumed amount with a cash reduction).
 *
 * `amount` is the amount originally reserved; `remaining` is the unconsumed
 * portion (`initial amount - consumed`). `0 <= remaining <= amount`.
 */
export interface OrderReservation {
  /** The logical order this reservation (1:1) belongs to, keyed by orderId. */
  orderId: string;
  /** The quote currency being reserved. */
  currency: string;
  /** Amount originally reserved for the order. */
  amount: Money;
  /** Remaining unconsumed amount. Starts equal to `amount`. */
  remaining: Money;
  /** Reservation lifecycle state. */
  status: ReservationStatus;
}

/**
 * A fill that has already been applied to the Portfolio, keyed by its execution
 * identity (Gate 7.2). Storing the exact applied payload lets the idempotent
 * path recognize a duplicate observation of the same execution (no mutation) and
 * reject a CONFLICTING observation (same execution identity but a different
 * payload) as a fail-closed reconciliation signal — never silently treat the
 * conflict as a brand-new fill. Identity is execution identity, NOT order/order
 * status; an order may have many executions, and `FILLED` never means "all
 * fills accounted once".
 */
export interface AppliedExecution {
  /** The logical order this execution was applied to (must match on replay). */
  orderId: string;
  /** Symbol/market the fill belongs to. */
  symbol: string;
  /** Side of the executed fill. */
  side: 'BUY' | 'SELL';
  /** Base quantity filled. */
  quantity: Money;
  /** Fill price (quote per base unit). */
  price: Money;
  /** Fee charged on the fill (quote). */
  fee: Money;
}

/**
 * An ORDER-LEVEL manual accounting settlement (Gate 9).
 *
 * This is deliberate and distinct from `AppliedExecution`:
 *  - `AppliedExecution` is keyed by a trustworthy EXECUTION identity and guards
 *    the exactly-once per-fill live path (`applyLiveFill`). It is the path for
 *    RETRAC-SUBMITTED live orders.
 *  - `ManualSettlement` is keyed by the MANUAL INTENT id (one order-level
 *    settlement per manual intent) and accounts an OPERATOR-EXECUTED external
 *    trade at the ORDER aggregate level (final filled quantity x average price
 *    + fee). It NEVER uses `applyLiveFill`, NEVER fabricates an execution
 *    identity, and NEVER treats an exchange `OrderId` as an execution id — an
 *    order is a container of zero or more executions, not an execution.
 *
 * Because it lives in the SAME portfolio file (and its mutation is written
 * atomically with the cash/positions it guards), a manual settlement can never
 * be double-applied across a crash, and it can never be confused with the live
 * per-execution ledger (different key domain, different map).
 */
export interface ManualSettlement {
  /** The manual intent this settlement belongs to (1:1, keyed by intentId). */
  intentId: string;
  /** External exchange OrderId captured as evidence (null if cleared). */
  orderId: string | null;
  /** Symbol/market of the executed trade. */
  symbol: string;
  /** Side of the executed order. */
  side: 'BUY' | 'SELL';
  /** Final authoritative filled quantity (order aggregate, base units). */
  quantity: Money;
  /** Authoritative average fill price (quote per base unit). */
  price: Money;
  /** Total fee applied in the quote currency. */
  fee: Money;
  /** Where the evidence originated ('operator' | 'exchange_read' | 'ndax_ui' | ...). */
  evidenceSource: string;
  /** True when the evidence was validated against an authoritative exchange read. */
  exchangedValidated: boolean;
  /**
   * The ACCOUNTING AUTHORITY that dictated the recorded numbers. This encodes the
   * distinction the intent state `ACCOUNTED_WITH_EXCHANGE_VALIDATION` vs
   * `ACCOUNTED_WITH_OPERATOR_ATTESTATION` conveys at the portfolio/accounting
   * layer:
   *  - `'exchange_validated'`: accounting used authoritative exchange evidence.
   *  - `'operator_attested'`: accounting relies on operator attestation for
   *    intent-to-order attribution (exchange consistency still validated).
   * It is NEVER a provenance proof.
   */
  settlementMode: 'exchange_validated' | 'operator_attested';
  /**
   * ALWAYS `false`. This settlement is operator-attested + exchange-consistent
   * accounting; it is NEVER exchange/cryptographic proof that the operator chose
   * the intended order. Encoding it as the literal `false` type makes it
   * impossible for this field to ever be `true`.
   */
  provenanceProof: false;
  /** Operator identity/acknowledgement that explicitly confirmed this settlement. */
  operatorConfirmedBy: string | null;
  /** Exchange-reported execution/update time (ms epoch), if known; else null. */
  executedAtMs: number | null;
  /** Local time the settlement was applied (ms epoch). */
  createdAtMs: number;
}

/** A single open (long) position in the bot-MANAGED portfolio. V1 is long-only. */
export interface PaperPosition {
  symbol: string;
  /** Net quantity in base units (>= 0). */
  quantity: Money;
  /** Average entry price (quote per base unit), including fees on entry. */
  averageEntryPrice: Money;
  /** Remaining cost basis (quote) attributable to the held quantity. */
  costBasis: Money;
  /** Realized P&L (quote) from sells against this position. */
  realizedPnl: Money;
  /** Total fees (quote) paid on this position's buys/sells. */
  feesPaid: Money;
  /** Where this managed holding originated (coarse identity of the position). */
  source: PositionSource;
  /**
   * Exact per-source quantity provenance (sums to `quantity`). This preserves
   * the fact that BOT inventory predates an external authorization and is never
   * silently reclassified. Derived from `source` for legacy persisted models
   * that predate this field.
   */
  sourceQuantities: SourceQuantities;
}

/**
 * Immutable-ish portfolio state. Mutating methods on `Portfolio` return a new
 * `PortfolioModel` (functional style) so state changes are explicit and easy to
 * persist/log.
 */
export interface PortfolioModel {
  /** Available cash by currency (quote/settlement currencies). */
  cash: Map<string, Money>;
  /** Open positions by symbol (bot-MANAGED only; never external). */
  positions: Map<string, PaperPosition>;
  /** Peak aggregate equity (quote), for drawdown calculations. */
  peakEquity: Money;
  /** Aggregate realized P&L (quote) across all positions. */
  realizedPnl: Money;
  /** Aggregate fees paid (quote) across all trades. */
  totalFees: Money;
  /**
   * EXTERNAL holdings: assets that existed before the bot began managing the
   * account (or that the user acquired outside the bot). These are recorded at
   * onboarding and are NOT bot-managed: they cannot be sold automatically and
   * do not count as bot position/exposure. A user must explicitly authorize an
   * asset to move it into bot-management (`authorizeExternal`).
   */
  externalSnapshot: Map<string, Money>;
  /**
   * Symbols the user EXPLICITLY authorized the bot to manage from external
   * inventory. Absence means the external asset stays protected.
   */
  authorizedExternal: Set<string>;
  /**
   * Quote currency reserved by in-flight bot BUY orders (not yet filled). The
   * bot must not spend reserved capital twice; deployable = cash - reserved.
   * This is the AGGREGATE committed pool (all order reservations + any
   * fungible `reserveQuote` reservations). Gate 7.1 adds the per-order
   * breakdown below; the aggregate drives `deployableQuote`.
   */
  reserved: Map<string, Money>;
  /**
   * Order-linked reservations keyed by logical order id (Gate 7.1). Each entry
   * attributes a precise reserved amount to ONE logical order so a future live
   * lifecycle can consume partial fills and release exactly once, without
   * crossing order boundaries. The aggregate `reserved` pool is the sum of the
   * active amounts here (plus any fungible-only reservations).
   */
  orderReservations: Map<string, OrderReservation>;
  /**
   * Execution identities already applied to the Portfolio, keyed by execution
   * id (Gate 7.2). This is the idempotency ledger: a fill whose execution id is
   * present here has already mutated cash/position/P&L, so the same execution is
   * never applied twice — including across restarts (it is persisted with the
   * portfolio). Co-located with the cash/positions it guards, so accounting and
   * the "applied" marker are written atomically in one portfolio file.
   */
  appliedExecutions: Map<string, AppliedExecution>;
  /**
   * ORDER-LEVEL manual settlements keyed by manual intent id (Gate 9). Each
   * entry is a verified, operator-reviewed accounting of an externally-executed
   * trade at the order aggregate level. Co-located with the cash/positions it
   * guards so accounting + the "settled" marker are written atomically. NEVER
   * used to bypass `appliedExecutions`: a manual settlement is a distinct,
   * deliberately separate accounting path keyed by intent, not by execution id.
   */
  manualSettlements: Map<string, ManualSettlement>;
}

/** A currency amount produced by an execution fill (cash delta). */
export interface CashFlow {
  currency: string;
  amount: Money;
}
