/**
 * ManualIntentStore — the durable store for manual-execution trade intents
 * (realm=`live`, domain=`manual-intents`).
 *
 * Architecturally SEPARATE from `OrderStore` (RETRAC-submitted orders) and from
 * the portfolio state file. Manual intents are RECOMMENDATIONS for an OPERATOR
 * to execute externally; they are never submitted by RETRAC.
 *
 * Fail-closed loading: a corrupted intent store is NEVER silently read as "no
 * intents" — it can hide active reservations or unresolved executions. Only a
 * genuinely absent file (fresh state) returns an empty view; every corruption
 * class throws `CorruptManualIntentStoreError` (the manual bridge relies on
 * this). The file is a versioned envelope, written atomically inside the
 * state-directory mutation lock.
 */

import { dirname } from 'node:path';
import { Money } from '../money/Money.js';
import type {
  ManualEvidence,
  ManualEvent,
  ManualIntentStatus,
  ManualRiskSnapshot,
  ManualTradeIntent,
  EVIDENCE_SOURCE,
} from './types.js';
import type { OrderSide, OrderStatus, OrderTif, OrderType } from '../order.js';
import { MANUAL_INTENT_STATUS } from './types.js';
import { readEnvelope, writeEnvelope } from '../persistence/envelope.js';
import { withStateDirLock } from '../persistence/lock.js';
import type { LoadResult } from '../persistence/types.js';

/**
 * Raised when the manual-intent store is present but unreadable/corrupt or has
 * an unsupported version. This is DELIBERATELY distinct from "no file yet"
 * (which is a legitimate fresh, empty state). A corrupted store must NEVER be
 * silently treated as "there are no intents": it could hide active reservations
 * or unresolved executions, so callers must fail closed.
 */
export class CorruptManualIntentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptManualIntentStoreError';
  }
}

/**
 * v1 allowed a single conflated `SETTLED` status. v2 (Gate 9.5) splits it into
 * `ACCOUNTED_WITH_EXCHANGE_VALIDATION` / `ACCOUNTED_WITH_OPERATOR_ATTESTATION`
 * and adds `PENDING` + `RECONCILIATION_REQUIRED`. A v1 payload is migrated on
 * load (old `SETTLED` -> `ACCOUNTED_WITH_EXCHANGE_VALIDATION`); a v2 payload that
 * still contains `SETTLED` is corrupt.
 */
const VALID_INTENT_STATUSES_V1: ReadonlySet<string> = new Set([
  'PROPOSED',
  'CONFIRMED',
  'EVIDENCE_RECORDED',
  'SETTLED',
  'CANCELED',
  'VOID',
  'AMBIGUOUS',
]);
const VALID_INTENT_STATUSES_V2: ReadonlySet<string> = new Set(MANUAL_INTENT_STATUS);
const VALID_EVIDENCE_SOURCES: ReadonlySet<string> = new Set([
  'operator',
  'exchange_read',
  'ndax_ui',
  'ndax_api',
  'other',
]);

/** The payload of a manual-intents file (the legacy shape, wrapped in an envelope). */
export interface ManualIntentFile {
  version: 1 | 2;
  /** Intents keyed by intentId (Money fields stored as decimal strings). */
  intents: Record<string, JsonManualIntent>;
  savedAtMs: number;
}

type JsonManualEvidence = {
  orderId: string | null;
  status: OrderStatus | null;
  filledQuantity: string | null;
  averagePrice: string | null;
  fee: string | null;
  feeCurrency: 'base' | 'quote';
  evidenceSource: (typeof EVIDENCE_SOURCE)[number];
  recordedAtMs: number;
  note?: string;
};

type JsonRiskSnapshot = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  referencePrice: string;
  estimatedNotional: string;
  estimatedFee: string;
  quoteCurrency: string;
  requiredBalance: string;
  deployableQuoteAtProposal: string;
  portfolioValueAtProposal: string;
  peakPortfolioValueAtProposal: string;
  portfolioExposureAtProposal: string;
  currentPositionAtProposal: string;
  openManagedPositionCountAtProposal: number;
  appliedLimits: Record<string, unknown>;
  marketDataTimestampMs: number | null;
  marketDataObservedAtMs: number;
  proposalTimeMs: number;
};

type JsonManualIntent = {
  intentId: string;
  status: ManualIntentStatus;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  limitPrice: string | null;
  tif: OrderTif | null;
  reason: string;
  riskSnapshot: JsonRiskSnapshot;
  evidence: JsonManualEvidence | null;
  operatorConfirmedBy: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  events: { ts: number; type: string; actor: 'operator' | 'system'; detail?: string }[];
  reservationCurrency: string | null;
  reservationAmount: string | null;
};

export class ManualIntentStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  /** Tri-state load (OK / MISSING / CORRUPT). CORRUPT is never MISSING. */
  load(): LoadResult<ManualIntentFile> {
    const r = readEnvelope(this.filePath, 'live', 'manual-intents');
    if (r.status !== 'OK') return r;
    try {
      const payload = validatePayload(r.data.payload);
      return { status: 'OK', data: payload };
    } catch (err) {
      return { status: 'CORRUPT', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** All known intents as a Map keyed by intentId. Throws on CORRUPT. */
  allIntents(): Map<string, ManualTradeIntent> {
    const file = this.loadOrThrow();
    const map = new Map<string, ManualTradeIntent>();
    if (file) {
      for (const [k, v] of Object.entries(file.intents)) map.set(k, intentFromJson(v));
    }
    return map;
  }

  /** Look up an intent by id. Throws on CORRUPT. */
  get(intentId: string): ManualTradeIntent | null {
    const intent = this.loadOrThrow()?.intents[intentId];
    return intent ? intentFromJson(intent) : null;
  }

  /** Persist (upsert) an intent. Refuses to overwrite a corrupt store. */
  save(intent: ManualTradeIntent): void {
    withStateDirLock(dirname(this.filePath), () => {
      const file = this.mutableFile();
      file.intents[intent.intentId] = intentToJson(intent);
      file.savedAtMs = Date.now();
      this.write(file);
    });
  }

  /** Persist several intents at once (atomic). Refuses to overwrite a corrupt store. */
  saveAll(intents: Iterable<ManualTradeIntent>): void {
    withStateDirLock(dirname(this.filePath), () => {
      const file = this.mutableFile();
      for (const i of intents) file.intents[i.intentId] = intentToJson(i);
      file.savedAtMs = Date.now();
      this.write(file);
    });
  }

  private write(file: ManualIntentFile): void {
    writeEnvelope(this.filePath, 'live', 'manual-intents', file);
  }

  /** Internal: load the payload, throwing on CORRUPT and returning null on MISSING. */
  private loadOrThrow(): ManualIntentFile | null {
    const r = this.load();
    if (r.status === 'CORRUPT') {
      throw new CorruptManualIntentStoreError(`manual intent store is corrupt: ${r.reason}`);
    }
    return r.status === 'OK' ? r.data : null;
  }

  /** Internal: a mutable file for save(); throws on CORRUPT, empty on MISSING. */
  private mutableFile(): ManualIntentFile {
    const r = this.load();
    if (r.status === 'CORRUPT') {
      throw new CorruptManualIntentStoreError(
        `manual intent store is corrupt (${r.reason}); refusing to overwrite it — operator must reconcile`,
      );
    }
    return r.status === 'OK' ? r.data : { version: 2 as const, intents: {}, savedAtMs: 0 };
  }
}

/** Validate a manual-intents payload; returns a migrated, validated file. */
function validatePayload(raw: unknown): ManualIntentFile {
  const json = raw as Record<string, unknown>;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new CorruptManualIntentStoreError('manual intent store payload is not an object');
  }
  const version = assertPayloadStructure(json);
  const file = json as { version: 1 | 2; intents: Record<string, unknown>; savedAtMs: number };
  for (const [key, value] of Object.entries(file.intents)) {
    assertValidIntentEntry(key, value, version);
  }
  return migratePayload(file as unknown as ManualIntentFile, version);
}

/** Assert the payload has the expected shape; returns the intent-status version. */
function assertPayloadStructure(json: Record<string, unknown>): 1 | 2 {
  if (json.version !== 1 && json.version !== 2) {
    throw new CorruptManualIntentStoreError(
      `manual intent store has unsupported version ${String(json.version)}`,
    );
  }
  if (!json.intents || typeof json.intents !== 'object' || Array.isArray(json.intents)) {
    throw new CorruptManualIntentStoreError('manual intent store is missing its intents map');
  }
  if (typeof json.savedAtMs !== 'number' || !Number.isFinite(json.savedAtMs)) {
    if (json.savedAtMs !== undefined && !Number.isFinite(json.savedAtMs)) {
      throw new CorruptManualIntentStoreError('manual intent store has a non-numeric savedAtMs');
    }
  }
  return json.version === 1 ? 1 : 2;
}

/** v1 -> v2 status migration (the ONLY change: split the conflated SETTLED). */
function migratePayload(file: ManualIntentFile, version: 1 | 2): ManualIntentFile {
  if (version === 1) {
    const intents: Record<string, JsonManualIntent> = {};
    for (const [k, rawValue] of Object.entries(file.intents)) {
      const entry = rawValue as Record<string, unknown>;
      const status = typeof entry.status === 'string' ? entry.status : '';
      intents[k] =
        status === 'SETTLED'
          ? { ...(entry as unknown as JsonManualIntent), status: 'ACCOUNTED_WITH_EXCHANGE_VALIDATION' }
          : (entry as unknown as JsonManualIntent);
    }
    return { version: 2, intents, savedAtMs: file.savedAtMs };
  }
  return file;
}

function assertMoneyString(value: unknown, field: string): void {
  if (value === null || value === undefined) return; // nullable fields allowed
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CorruptManualIntentStoreError(`${field} must be a non-empty decimal string`);
  }
  try {
    Money.fromString(value);
  } catch {
    throw new CorruptManualIntentStoreError(`${field} is not a valid decimal amount: "${value}"`);
  }
}

function assertValidIntentEntry(key: string, value: unknown, version: 1 | 2): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CorruptManualIntentStoreError(`intent "${key}" is not an object`);
  }
  const it = value as Record<string, unknown>;
  if (it.intentId !== key) {
    throw new CorruptManualIntentStoreError(`intent keyed "${key}" declares intentId "${String(it.intentId)}"`);
  }
  if (typeof it.intentId !== 'string' || it.intentId === '') {
    throw new CorruptManualIntentStoreError(`intent "${key}" has an empty intentId`);
  }
  const validStatuses = version === 1 ? VALID_INTENT_STATUSES_V1 : VALID_INTENT_STATUSES_V2;
  if (typeof it.status !== 'string' || !validStatuses.has(it.status)) {
    throw new CorruptManualIntentStoreError(`intent "${key}" has invalid status "${String(it.status)}"`);
  }
  if ((it.side !== 'BUY' && it.side !== 'SELL')) {
    throw new CorruptManualIntentStoreError(`intent "${key}" has invalid side "${String(it.side)}"`);
  }
  if (it.type !== 'market' && it.type !== 'limit') {
    throw new CorruptManualIntentStoreError(`intent "${key}" has invalid type "${String(it.type)}"`);
  }
  assertMoneyString(it.quantity, `intent "${key}".quantity`);
  if (it.quantity !== undefined) {
    const q = Money.fromString(it.quantity as string);
    if (!q.isPositive()) {
      throw new CorruptManualIntentStoreError(`intent "${key}" has a non-positive quantity "${it.quantity}"`);
    }
  }
  assertMoneyString(it.limitPrice, `intent "${key}".limitPrice`);
  if (it.limitPrice !== null && it.limitPrice !== undefined) {
    const lp = Money.fromString(it.limitPrice as string);
    if (!lp.isPositive()) {
      throw new CorruptManualIntentStoreError(`intent "${key}" has a non-positive limitPrice "${it.limitPrice}"`);
    }
  }
  const rs = it.riskSnapshot;
  if (typeof rs !== 'object' || rs === null) {
    throw new CorruptManualIntentStoreError(`intent "${key}" is missing its riskSnapshot`);
  }
  const rr = rs as Record<string, unknown>;
  assertMoneyString(rr.referencePrice, `intent "${key}".riskSnapshot.referencePrice`);
  assertMoneyString(rr.estimatedNotional, `intent "${key}".riskSnapshot.estimatedNotional`);
  assertMoneyString(rr.estimatedFee, `intent "${key}".riskSnapshot.estimatedFee`);
  assertMoneyString(rr.requiredBalance, `intent "${key}".riskSnapshot.requiredBalance`);

  if (it.evidence !== null && it.evidence !== undefined) {
    const ev = it.evidence as Record<string, unknown>;
    if (typeof ev !== 'object' || ev === null) {
      throw new CorruptManualIntentStoreError(`intent "${key}" has malformed evidence`);
    }
    if (ev.orderId !== null && typeof ev.orderId !== 'string') {
      throw new CorruptManualIntentStoreError(`intent "${key}".evidence.orderId must be a string or null`);
    }
    if (ev.feeCurrency !== 'base' && ev.feeCurrency !== 'quote') {
      throw new CorruptManualIntentStoreError(`intent "${key}".evidence.feeCurrency must be base or quote`);
    }
    if (typeof ev.evidenceSource !== 'string' || !VALID_EVIDENCE_SOURCES.has(ev.evidenceSource)) {
      throw new CorruptManualIntentStoreError(`intent "${key}" has invalid evidenceSource "${String(ev.evidenceSource)}"`);
    }
    assertMoneyString(ev.filledQuantity, `intent "${key}".evidence.filledQuantity`);
    if (ev.filledQuantity !== null && ev.filledQuantity !== undefined) {
      const fq = Money.fromString(ev.filledQuantity as string);
      if (fq.isNegative()) {
        throw new CorruptManualIntentStoreError(`intent "${key}".evidence.filledQuantity is negative`);
      }
    }
    assertMoneyString(ev.averagePrice, `intent "${key}".evidence.averagePrice`);
    assertMoneyString(ev.fee, `intent "${key}".evidence.fee`);
  }

  assertMoneyString(it.reservationAmount, `intent "${key}".reservationAmount`);
  if (it.reservationAmount !== null && it.reservationAmount !== undefined) {
    const ra = Money.fromString(it.reservationAmount as string);
    if (!ra.isPositive()) {
      throw new CorruptManualIntentStoreError(`intent "${key}".reservationAmount must be positive`);
    }
  }
  if (it.reservationCurrency !== null && typeof it.reservationCurrency !== 'string') {
    throw new CorruptManualIntentStoreError(`intent "${key}".reservationCurrency must be a string or null`);
  }
  if (
    typeof it.createdAtMs !== 'number' ||
    !Number.isFinite(it.createdAtMs) ||
    typeof it.updatedAtMs !== 'number' ||
    !Number.isFinite(it.updatedAtMs)
  ) {
    throw new CorruptManualIntentStoreError(`intent "${key}" has non-finite timestamps`);
  }
  if (!Array.isArray(it.events)) {
    throw new CorruptManualIntentStoreError(`intent "${key}" is missing its events array`);
  }
}

function intentToJson(i: ManualTradeIntent): JsonManualIntent {
  return {
    intentId: i.intentId,
    status: i.status,
    symbol: i.symbol,
    side: i.side,
    type: i.type,
    quantity: i.quantity.toString(),
    limitPrice: i.limitPrice ? i.limitPrice.toString() : null,
    tif: i.tif,
    reason: i.reason,
    riskSnapshot: {
      symbol: i.riskSnapshot.symbol,
      side: i.riskSnapshot.side,
      type: i.riskSnapshot.type,
      referencePrice: i.riskSnapshot.referencePrice.toString(),
      estimatedNotional: i.riskSnapshot.estimatedNotional.toString(),
      estimatedFee: i.riskSnapshot.estimatedFee.toString(),
      quoteCurrency: i.riskSnapshot.quoteCurrency,
      requiredBalance: i.riskSnapshot.requiredBalance.toString(),
      deployableQuoteAtProposal: i.riskSnapshot.deployableQuoteAtProposal.toString(),
      portfolioValueAtProposal: i.riskSnapshot.portfolioValueAtProposal.toString(),
      peakPortfolioValueAtProposal: i.riskSnapshot.peakPortfolioValueAtProposal.toString(),
      portfolioExposureAtProposal: i.riskSnapshot.portfolioExposureAtProposal.toString(),
      currentPositionAtProposal: i.riskSnapshot.currentPositionAtProposal.toString(),
      openManagedPositionCountAtProposal: i.riskSnapshot.openManagedPositionCountAtProposal,
      appliedLimits: i.riskSnapshot.appliedLimits as unknown as Record<string, unknown>,
      marketDataTimestampMs: i.riskSnapshot.marketDataTimestampMs,
      marketDataObservedAtMs: i.riskSnapshot.marketDataObservedAtMs,
      proposalTimeMs: i.riskSnapshot.proposalTimeMs,
    },
    evidence: i.evidence
      ? {
          orderId: i.evidence.orderId,
          status: i.evidence.status,
          filledQuantity: i.evidence.filledQuantity ? i.evidence.filledQuantity.toString() : null,
          averagePrice: i.evidence.averagePrice ? i.evidence.averagePrice.toString() : null,
          fee: i.evidence.fee ? i.evidence.fee.toString() : null,
          feeCurrency: i.evidence.feeCurrency,
          evidenceSource: i.evidence.evidenceSource,
          recordedAtMs: i.evidence.recordedAtMs,
          ...(i.evidence.note !== undefined ? { note: i.evidence.note } : {}),
        }
      : null,
    operatorConfirmedBy: i.operatorConfirmedBy,
    createdAtMs: i.createdAtMs,
    updatedAtMs: i.updatedAtMs,
    events: i.events.map((e) => ({ ts: e.ts, type: e.type, actor: e.actor, ...(e.detail ? { detail: e.detail } : {}) })),
    reservationCurrency: i.reservationCurrency,
    reservationAmount: i.reservationAmount ? i.reservationAmount.toString() : null,
  };
}

function intentFromJson(j: JsonManualIntent): ManualTradeIntent {
  const rs = j.riskSnapshot;
  const riskSnapshot: ManualRiskSnapshot = {
    symbol: rs.symbol,
    side: rs.side,
    type: rs.type,
    referencePrice: Money.fromString(rs.referencePrice),
    estimatedNotional: Money.fromString(rs.estimatedNotional),
    estimatedFee: Money.fromString(rs.estimatedFee),
    quoteCurrency: rs.quoteCurrency,
    requiredBalance: Money.fromString(rs.requiredBalance),
    deployableQuoteAtProposal: Money.fromString(rs.deployableQuoteAtProposal),
    portfolioValueAtProposal: Money.fromString(rs.portfolioValueAtProposal),
    peakPortfolioValueAtProposal: Money.fromString(rs.peakPortfolioValueAtProposal),
    portfolioExposureAtProposal: Money.fromString(rs.portfolioExposureAtProposal),
    currentPositionAtProposal: Money.fromString(rs.currentPositionAtProposal),
    openManagedPositionCountAtProposal: rs.openManagedPositionCountAtProposal,
    appliedLimits: rs.appliedLimits as unknown as ManualTradeIntent['riskSnapshot']['appliedLimits'],
    marketDataTimestampMs: rs.marketDataTimestampMs,
    marketDataObservedAtMs: rs.marketDataObservedAtMs,
    proposalTimeMs: rs.proposalTimeMs,
  };
  const ev = j.evidence;
  const evidence: ManualEvidence | null = ev
    ? {
        orderId: ev.orderId,
        status: ev.status,
        filledQuantity: ev.filledQuantity !== null ? Money.fromString(ev.filledQuantity) : null,
        averagePrice: ev.averagePrice !== null ? Money.fromString(ev.averagePrice) : null,
        fee: ev.fee !== null ? Money.fromString(ev.fee) : null,
        feeCurrency: ev.feeCurrency,
        evidenceSource: ev.evidenceSource,
        recordedAtMs: ev.recordedAtMs,
        ...(ev.note !== undefined ? { note: ev.note } : {}),
      }
    : null;
  const events: ManualEvent[] = j.events.map((e) => ({ ts: e.ts, type: e.type, actor: e.actor, ...(e.detail ? { detail: e.detail } : {}) }));
  return {
    intentId: j.intentId,
    status: j.status,
    symbol: j.symbol,
    side: j.side,
    type: j.type,
    quantity: Money.fromString(j.quantity),
    limitPrice: j.limitPrice !== null ? Money.fromString(j.limitPrice) : null,
    tif: j.tif,
    reason: j.reason,
    riskSnapshot,
    evidence,
    operatorConfirmedBy: j.operatorConfirmedBy,
    createdAtMs: j.createdAtMs,
    updatedAtMs: j.updatedAtMs,
    events,
    reservationCurrency: j.reservationCurrency,
    reservationAmount: j.reservationAmount !== null ? Money.fromString(j.reservationAmount) : null,
  };
}
