/**
 * Portfolio JSON serialization (for persistence / logging).
 *
 * `Money` is stored as its canonical decimal string so values survive a restart
 * exactly and are human-readable in a state file.
 *
 * State versioning (Gate 5 / F-5):
 *   - Version 2 (`PORTFOLIO_STATE_VERSION`, the CURRENT explicit format) requires
 *     every position to carry an explicit `source` AND a conservation-consistent
 *     `sourceQuantities` breakdown (`BOT + EXTERNAL_AUTHORIZED === quantity`).
 *     A v2 document that omits or corrupts ownership FAILS CLOSED (throws).
 *   - Version 1 is the legacy shape. It predates Gate 5 (a bare position with no
 *     ownership) and an intermediate Gate-5 write (explicit `source` but no
 *     `sourceQuantities`). Interpretation is realm-aware:
 *       - a v1 position carrying explicit `source` (+ optional provenance) is
 *         UNAMBIGUOUS and is accepted (validated for conservation).
 *       - a v1 position with NO `source` and NO `sourceQuantities` is the truly
 *         legacy form. In the PAPER realm it is deterministically treated as a
 *         historical bot-created paper BOT position (these were simulated trades,
 *         never external). In the LIVE realm it FAILS CLOSED — ambiguous
 *         ownership must never silently become live-managed, tradable inventory.
 *
 * A state file therefore only has legacy BOT semantics in the paper realm; a live
 * managed-state file can never inherit a default-BOT ownership from missing data.
 */

import { Money } from '../money/Money.js';
import type {
  PortfolioModel,
  PaperPosition,
  PositionSource,
  SourceQuantities,
  OrderReservation,
  ReservationStatus,
  AppliedExecution,
  ManualSettlement,
} from './types.js';

/** Current explicit portfolio state format version. */
export const PORTFOLIO_STATE_VERSION = 2;

/** The realm a state file belongs to. Determines how legacy ambiguity is resolved. */
export type StateRealm = 'paper' | 'live';

export interface DeserializeOptions {
  /**
   * Realm context for interpreting legacy (v1) state. Defaults to `'live'`,
   * which is fail-closed: any truly-legacy position with no ownership source
   * REFUSES to load rather than being silently treated as BOT-managed.
   */
  realm?: StateRealm;
}

/** A position in the current explicit (v2) format: ownership is REQUIRED. */
export interface PositionJsonV2 {
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  feesPaid: string;
  source: PositionSource;
  sourceQuantities: Record<PositionSource, string>;
}

/** A position in the legacy (v1) format: ownership components are optional. */
export interface PositionJsonV1 {
  symbol: string;
  quantity: string;
  averageEntryPrice: string;
  costBasis: string;
  realizedPnl: string;
  feesPaid: string;
  /** Optional in v1 files written before Gate 5 — interpreted by realm. */
  source?: PositionSource;
  /**
   * Optional (Gate 5.5): per-source quantity provenance. Files before Gate 5.5
   * omit it; on load it is derived from `source` + `quantity`.
   */
  sourceQuantities?: Partial<Record<PositionSource, string>>;
}

export type PositionJson = PositionJsonV1 | PositionJsonV2;

interface PortfolioJsonBase {
  cash: Record<string, string>;
  positions: Record<string, PositionJson>;
  peakEquity: string;
  realizedPnl: string;
  totalFees: string;
  /** Optional (Gate 5): external holdings that are NOT bot-managed. */
  externalSnapshot?: Record<string, string>;
  /** Optional (Gate 5): external assets the user explicitly authorized. */
  authorizedExternal?: string[];
  /** Optional (Gate 5): quote reserved by in-flight bot orders. */
  reserved?: Record<string, string>;
  /**
   * Optional (Gate 7.1): order-linked reservations, keyed by logical order id.
   * Absent in legacy files (before Gate 7.1) => safely loaded as empty; a
   * reservation's linkage to a specific order cannot be reconstructed from a
   * fungible-only `reserved` map, so legacy state simply has no order linkage
   * and nothing is invented. When present, each entry is validated and fails
   * closed if malformed (a reservation may not go negative or exceed restorable
   * funds).
   */
  orderReservations?: Record<string, OrderReservationJson>;
  /**
   * Optional (Gate 7.2): execution identities already applied to the Portfolio,
   * keyed by execution id. Absent in legacy files (before Gate 7.2) => safely
   * loaded as empty (nothing is invented or assumed "already applied", so a
   * previously un-applied region is either absent or reconciled). When present,
   * each entry is validated and fails closed if malformed (a conflict is a
   * reconciliation signal, never silently dropped).
   */
  appliedExecutions?: Record<string, AppliedExecutionJson>;
  /**
   * Optional (Gate 9): order-level manual settlements keyed by manual intent id.
   * Absent in legacy files (before Gate 9) => safely loaded as empty (nothing is
   * invented or assumed "already settled", so a previously un-settled manual
   * intent is either settled once or left for the operator). When present, each
   * entry is validated and fails closed if malformed (a conflict is a
   * reconciliation signal, never silently dropped).
   */
  manualSettlements?: Record<string, ManualSettlementJson>;
}

/** JSON-safe form of an OrderReservation (Money fields as decimal strings). */
interface OrderReservationJson {
  orderId: string;
  currency: string;
  amount: string;
  remaining: string;
  status: ReservationStatus;
}

/** JSON-safe form of an AppliedExecution (Money fields as decimal strings). */
interface AppliedExecutionJson {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
}

/** JSON-safe form of a ManualSettlement (Money fields as decimal strings). */
interface ManualSettlementJson {
  intentId: string;
  orderId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  evidenceSource: string;
  exchangedValidated: boolean;
  /** Optional for legacy rows; defaults from `exchangedValidated` on read. */
  settlementMode?: 'exchange_validated' | 'operator_attested';
  /** Optional for legacy rows; ALWAYS read back as `false`. */
  provenanceProof?: false;
  operatorConfirmedBy: string | null;
  executedAtMs: number | null;
  createdAtMs: number;
}

export interface PortfolioJsonV1 extends PortfolioJsonBase {
  version: 1;
}

export interface PortfolioJsonV2 extends PortfolioJsonBase {
  version: 2;
}

export type PortfolioJson = PortfolioJsonV1 | PortfolioJsonV2;

const VALID_SOURCES: ReadonlySet<string> = new Set(['BOT', 'EXTERNAL_AUTHORIZED']);

function isSupportedVersion(v: unknown): v is 1 | 2 {
  return v === 1 || v === 2;
}

/**
 * Assert the per-source provenance sums EXACTLY to the aggregate quantity.
 * Any violation means the ownership bookkeeping is corrupt and must fail closed
 * (this is the invariant `BOT + EXTERNAL_AUTHORIZED === quantity`).
 */
function assertConservation(symbol: string, quantity: Money, bot: Money, ext: Money): void {
  if (!bot.add(ext).equals(quantity)) {
    throw new Error(
      `Portfolio state ${symbol}: provenance BOT(${bot}) + EXTERNAL_AUTHORIZED(${ext}) ` +
        `does not equal quantity (${quantity})`,
    );
  }
}

/**
 * Assert an order reservation is internally consistent (Gate 7.1):
 *   - amount must be positive;
 *   - remaining must be in [0, amount];
 *   - a RELEASED reservation must have remaining === 0.
 * Any violation is corrupt state and fails closed (a reservation must never go
 * negative, never exceed the originally reserved amount, and never be releasable
 * twice).
 */
/**
 * Assert an applied-execution record is internally consistent (Gate 7.2):
 *   - the execution identity key is non-empty;
 *   - quantity/price are non-negative (a fill is a real exchange execution);
 *   - a BUY quantity must be positive.
 * Any violation is corrupt state and fails closed (an applied execution is never
 * malformed or reconstructed with an invented value).
 */
function assertAppliedExecutionConservation(execId: string, a: Pick<AppliedExecution, 'quantity' | 'price' | 'fee'>): void {
  if (!execId) {
    throw new Error('Portfolio state: applied execution with empty identity');
  }
  if (a.quantity.isNegative() || a.price.isNegative() || a.fee.isNegative()) {
    throw new Error(`Portfolio state: applied execution ${execId} has a negative quantity/price/fee`);
  }
}

/**
 * Assert a manual settlement is internally consistent (Gate 9):
 *   - the intent id key is non-empty;
 *   - quantity is positive (an executed order fills > 0 base units);
 *   - price and fee are non-negative.
 * Any violation is corrupt state and fails closed (a manual settlement is never
 * malformed or reconstructed with an invented value).
 */
function assertManualSettlementConservation(intentId: string, s: Pick<ManualSettlement, 'quantity' | 'price' | 'fee'>): void {
  if (!intentId) {
    throw new Error('Portfolio state: manual settlement with empty intent id');
  }
  if (s.quantity.isNegativeOrZero()) {
    throw new Error(`Portfolio state: manual settlement ${intentId} has non-positive quantity`);
  }
  if (s.price.isNegative() || s.fee.isNegative()) {
    throw new Error(`Portfolio state: manual settlement ${intentId} has a negative price/fee`);
  }
}

function assertReservationConservation(orderId: string, r: Pick<OrderReservation, 'amount' | 'remaining' | 'status'>): void {
  if (r.amount.isNegativeOrZero()) {
    throw new Error(`Portfolio state: order reservation for ${orderId} has non-positive amount (${r.amount})`);
  }
  if (r.remaining.isNegative()) {
    throw new Error(`Portfolio state: order reservation for ${orderId} has negative remaining (${r.remaining})`);
  }
  if (r.remaining.compareTo(r.amount) > 0) {
    throw new Error(
      `Portfolio state: order reservation for ${orderId} remaining (${r.remaining}) exceeds amount (${r.amount})`,
    );
  }
  if (r.status === 'RELEASED' && !r.remaining.isZero()) {
    throw new Error(`Portfolio state: order reservation for ${orderId} is RELEASED but has remaining ${r.remaining}`);
  }
}

export function serializePortfolio(state: PortfolioModel): PortfolioJsonV2 {
  const cash: Record<string, string> = {};
  for (const [cur, amount] of state.cash) cash[cur] = amount.toString();
  const positions: Record<string, PositionJson> = {};
  for (const [sym, p] of state.positions) {
    const sq: SourceQuantities = p.sourceQuantities
      ? { BOT: p.sourceQuantities.BOT ?? Money.zero(), EXTERNAL_AUTHORIZED: p.sourceQuantities.EXTERNAL_AUTHORIZED ?? Money.zero() }
      : {
          BOT: p.source === 'BOT' ? p.quantity : Money.zero(),
          EXTERNAL_AUTHORIZED: p.source === 'EXTERNAL_AUTHORIZED' ? p.quantity : Money.zero(),
        };
    // Never write a corrupt ownership breakdown to disk.
    assertConservation(sym, p.quantity, sq.BOT, sq.EXTERNAL_AUTHORIZED);
    const pj: PositionJsonV2 = {
      symbol: p.symbol,
      quantity: p.quantity.toString(),
      averageEntryPrice: p.averageEntryPrice.toString(),
      costBasis: p.costBasis.toString(),
      realizedPnl: p.realizedPnl.toString(),
      feesPaid: p.feesPaid.toString(),
      source: p.source,
      sourceQuantities: {
        BOT: sq.BOT.toString(),
        EXTERNAL_AUTHORIZED: sq.EXTERNAL_AUTHORIZED.toString(),
      },
    };
    positions[sym] = pj;
  }
  const externalSnapshot: Record<string, string> = {};
  for (const [cur, amount] of state.externalSnapshot) externalSnapshot[cur] = amount.toString();
  const reserved: Record<string, string> = {};
  for (const [cur, amount] of state.reserved) reserved[cur] = amount.toString();
  const orderReservations: Record<string, OrderReservationJson> = {};
  for (const [orderId, r] of state.orderReservations ?? []) {
    // Never write a corrupt reservation (remaining out of [0, amount]) to disk.
    assertReservationConservation(orderId, r);
    orderReservations[orderId] = {
      orderId: r.orderId,
      currency: r.currency,
      amount: r.amount.toString(),
      remaining: r.remaining.toString(),
      status: r.status,
    };
  }
  const appliedExecutions: Record<string, AppliedExecutionJson> = {};
  for (const [execId, a] of state.appliedExecutions ?? []) {
    assertAppliedExecutionConservation(execId, a);
    appliedExecutions[execId] = {
      orderId: a.orderId,
      symbol: a.symbol,
      side: a.side,
      quantity: a.quantity.toString(),
      price: a.price.toString(),
      fee: a.fee.toString(),
    };
  }
  // Never write a corrupt manual settlement to disk. Only include the key when
  // there is at least one settlement, so legacy/empty portfolios serialize
  // byte-identically to before the field existed.
  const manualSettlements: Record<string, ManualSettlementJson> = {};
  for (const [intentId, s] of state.manualSettlements ?? []) {
    assertManualSettlementConservation(intentId, s);
    manualSettlements[intentId] = {
      intentId: s.intentId,
      orderId: s.orderId,
      symbol: s.symbol,
      side: s.side,
      quantity: s.quantity.toString(),
      price: s.price.toString(),
      fee: s.fee.toString(),
      evidenceSource: s.evidenceSource,
      exchangedValidated: s.exchangedValidated,
      settlementMode: s.settlementMode,
      provenanceProof: s.provenanceProof,
      operatorConfirmedBy: s.operatorConfirmedBy,
      executedAtMs: s.executedAtMs,
      createdAtMs: s.createdAtMs,
    };
  }
  return {
    version: PORTFOLIO_STATE_VERSION,
    cash,
    positions,
    peakEquity: state.peakEquity.toString(),
    realizedPnl: state.realizedPnl.toString(),
    totalFees: state.totalFees.toString(),
    externalSnapshot,
    authorizedExternal: [...state.authorizedExternal],
    reserved,
    orderReservations,
    appliedExecutions,
    ...(Object.keys(manualSettlements).length > 0 ? { manualSettlements } : {}),
  };
}

/**
 * Parse one persisted position, resolving ownership safely.
 *
 * Fail-closed rules (see module header):
 *   - An invalid `source` value is malformed -> throw.
 *   - A provenance breakdown that does not conserve quantity -> throw.
 *   - A provenance breakdown with no explicit coarse `source` that is MIXED
 *     (both BOT and EXTERNAL_AUTHORIZED present) cannot have its coarse identity
 *     inferred -> throw (ambiguous).
 *   - A truly-legacy position (no `source`, no provenance) is ambiguous. In the
 *     `live` realm -> throw; in the `paper` realm -> deterministic BOT
 *     (historical bot-created paper trade). A version-2 doc is always strict.
 */
function parsePosition(sym: string, p: PositionJson, realm: StateRealm): PaperPosition {
  const quantity = Money.fromString(p.quantity);
  const averageEntryPrice = Money.fromString(p.averageEntryPrice);
  const costBasis = Money.fromString(p.costBasis);
  const realizedPnl = Money.fromString(p.realizedPnl);
  const feesPaid = Money.fromString(p.feesPaid);

  // F-10: V1 is long-only (quantity >= 0). A negative aggregate quantity is
  // corrupt state: it would under-count `expectedAssetBalances()` and could
  // mask an unexpected exchange decrease. Fail closed rather than load it.
  if (quantity.isNegative()) {
    throw new Error(`Portfolio state ${sym}: negative position quantity`);
  }

  let source: PositionSource | null = p.source ?? null;
  if (source !== null && !VALID_SOURCES.has(source)) {
    throw new Error(`Portfolio state ${sym}: unknown position source "${String(p.source)}"`);
  }

  let sourceQuantities: SourceQuantities;
  if (p.sourceQuantities) {
    const bot = Money.fromString(p.sourceQuantities.BOT ?? '0');
    const ext = Money.fromString(p.sourceQuantities.EXTERNAL_AUTHORIZED ?? '0');
    assertConservation(sym, quantity, bot, ext);
    if (source === null) {
      // Provenance present but the coarse identity is missing and it is mixed;
      // we cannot infer which source this position historically belonged to.
      if (!bot.isZero() && !ext.isZero()) {
        throw new Error(
          `Portfolio state ${sym}: mixed provenance without an explicit coarse source is ambiguous`,
        );
      }
      source = ext.isZero() ? 'BOT' : 'EXTERNAL_AUTHORIZED';
    }
    sourceQuantities = { BOT: bot, EXTERNAL_AUTHORIZED: ext };
  } else if (source !== null) {
    // Explicit single source, no provenance: derive all-in-source.
    sourceQuantities =
      source === 'BOT'
        ? { BOT: quantity, EXTERNAL_AUTHORIZED: Money.zero() }
        : { BOT: Money.zero(), EXTERNAL_AUTHORIZED: quantity };
  } else {
    // Truly-legacy position: no ownership recorded at all.
    if (realm === 'live') {
      throw new Error(
        `Portfolio state ${sym}: legacy position has no ownership source and cannot be safely ` +
          `treated as live-managed inventory; migrating it requires an explicit decision`,
      );
    }
    source = 'BOT';
    sourceQuantities = { BOT: quantity, EXTERNAL_AUTHORIZED: Money.zero() };
  }

  return { symbol: p.symbol, quantity, averageEntryPrice, costBasis, realizedPnl, feesPaid, source, sourceQuantities };
}

export function deserializePortfolio(json: PortfolioJson, options: DeserializeOptions = {}): PortfolioModel {
  const realm: StateRealm = options.realm ?? 'live';
  if (!isSupportedVersion(json.version)) {
    throw new Error(`Portfolio state uses unsupported version ${String(json.version)}`);
  }
  // A v2 document claims to be the current explicit format; if a position inside
  // it carries no ownership it is corrupt and must fail closed regardless of realm.
  const effectiveRealm: StateRealm = json.version === 2 ? 'live' : realm;

  const cash = new Map<string, Money>();
  for (const [cur, amount] of Object.entries(json.cash)) cash.set(cur, Money.fromString(amount));

  const positions = new Map<string, PaperPosition>();
  for (const [sym, p] of Object.entries(json.positions)) {
    positions.set(sym, parsePosition(sym, p, effectiveRealm));
  }

  const externalSnapshot = new Map<string, Money>();
  for (const [cur, amount] of Object.entries(json.externalSnapshot ?? {})) {
    const ext = Money.fromString(amount);
    // F-10: externalSnapshot is the operator's explicit declaration of
    // pre-existing (non-bot) holdings. A negative amount is corrupt: it would
    // under-count `expectedAssetBalances()` and could mask an unexpected
    // exchange decrease, or be used by `authorizeExternal` to manufacture a
    // broken position. Fail closed rather than load it.
    if (ext.isNegative()) {
      throw new Error(`Portfolio state: negative external snapshot amount for ${cur}`);
    }
    externalSnapshot.set(cur, ext);
  }
  const reserved = new Map<string, Money>();
  for (const [cur, amount] of Object.entries(json.reserved ?? {})) {
    const r = Money.fromString(amount);
    // F-9 fail-closed: a negative reservation would inflate deployable capital
    // (`cash - reserved` becomes `cash + |reserved|`), and a reservation larger
    // than the managed cash is an impossible state. Both are rejected so the
    // loader fails closed rather than silently manufacturing deployable quote.
    if (r.isNegative()) {
      throw new Error(`Portfolio state: negative reserved amount for ${cur}`);
    }
    const managing = cash.get(cur) ?? Money.zero();
    if (r.compareTo(managing) > 0) {
      throw new Error(`Portfolio state: reserved ${r} for ${cur} exceeds cash ${managing}`);
    }
    reserved.set(cur, r);
  }

  // Gate 7.1 order-linked reservations. Legacy documents (before this field)
  // have no order linkage; we cannot reconstruct which order a fungible-only
  // `reserved` amount belonged to, so we load them as empty (nothing invented).
  const orderReservations = new Map<string, OrderReservation>();
  for (const [orderId, jr] of Object.entries(json.orderReservations ?? {})) {
    if (jr.orderId !== orderId) {
      throw new Error(`Portfolio state: order reservation keyed by ${orderId} but declares orderId ${jr.orderId}`);
    }
    const r: OrderReservation = {
      orderId: jr.orderId,
      currency: jr.currency,
      amount: Money.fromString(jr.amount),
      remaining: Money.fromString(jr.remaining),
      status: jr.status,
    };
    assertReservationConservation(orderId, r);
    orderReservations.set(orderId, r);
  }

  // Gate 7.2 applied-execution ledger. Legacy documents (before this field) load
  // empty: we never assume an execution was already applied, and we never
  // reconstruct an identity — a previously-observed fill is simply re-observed
  // and applied once (or, if the exchange only supplies it, remains un-applied).
  const appliedExecutions = new Map<string, AppliedExecution>();
  for (const [execId, ja] of Object.entries(json.appliedExecutions ?? {})) {
    const a: AppliedExecution = {
      orderId: ja.orderId,
      symbol: ja.symbol,
      side: ja.side,
      quantity: Money.fromString(ja.quantity),
      price: Money.fromString(ja.price),
      fee: Money.fromString(ja.fee),
    };
    assertAppliedExecutionConservation(execId, a);
    appliedExecutions.set(execId, a);
  }

  // Gate 9 manual-settlement ledger. Legacy documents (before this field) load
  // empty: a previously-observed manual settlement is either re-settled once (if
  // it was never applied) or left unresolved (fail closed) — never assumed.
  const manualSettlements = new Map<string, ManualSettlement>();
  for (const [intentId, js] of Object.entries(json.manualSettlements ?? {})) {
    const s: ManualSettlement = {
      intentId: js.intentId,
      orderId: js.orderId,
      symbol: js.symbol,
      side: js.side,
      quantity: Money.fromString(js.quantity),
      price: Money.fromString(js.price),
      fee: Money.fromString(js.fee),
      evidenceSource: js.evidenceSource,
      exchangedValidated: js.exchangedValidated,
      // Legacy rows (pre-Gate-9.5) never stored these. Default the accounting
      // authority from `exchangedValidated` (old SETTLED always validated against
      // the exchange) and HARD-CODE provenanceProof to `false` — the literal type.
      settlementMode: js.settlementMode ?? (js.exchangedValidated ? 'exchange_validated' : 'operator_attested'),
      provenanceProof: false,
      operatorConfirmedBy: js.operatorConfirmedBy,
      executedAtMs: js.executedAtMs,
      createdAtMs: js.createdAtMs,
    };
    assertManualSettlementConservation(intentId, s);
    manualSettlements.set(intentId, s);
  }

  return {
    cash,
    positions,
    peakEquity: Money.fromString(json.peakEquity),
    realizedPnl: Money.fromString(json.realizedPnl),
    totalFees: Money.fromString(json.totalFees),
    externalSnapshot,
    authorizedExternal: new Set(json.authorizedExternal ?? []),
    reserved,
    orderReservations,
    appliedExecutions,
    manualSettlements,
  };
}
