/**
 * OrderStore — durable record of every order the bot has tried to place
 * (realm=`live`, domain=`order-ledger`).
 *
 * Persisting an order keyed by its local `clientOrderId` is what makes
 * duplicate-order prevention and restart recovery possible: no matter what
 * happens (crash, timeout, restart), we can always look up whether an order with
 * a given key was already attempted, and reconcile with the exchange rather than
 * blindly re-submitting.
 *
 * Fail-closed loading: a CORRUPT ledger is NEVER treated as empty. `save()` /
 * `saveAll()` refuse to overwrite a corrupt ledger (a corrupt ledger must never
 * be replaced by a fresh empty one, which would destroy order-attempt history and
 * the duplicate-order-prevention guarantee). Writes are atomic, inside the
 * state-directory mutation lock.
 */

import { dirname } from 'node:path';
import { Money } from '../money/Money.js';
import { ORDER_STATUS, type FeeCurrency, type Fill, type Order } from '../order.js';
import { readEnvelope, writeEnvelope } from './envelope.js';
import { withStateDirLock } from './lock.js';
import { CorruptStateError, type LoadResult } from './types.js';

/** The payload of an order-ledger file: orders keyed by clientOrderId. */
export interface OrderLedgerPayload {
  orders: Record<string, JsonOrder>;
}

/** Backward-compatible alias for the ledger payload. */
export type OrderLedgerV1 = OrderLedgerPayload;

/** JSON-safe form of Order where Money values are decimal strings. */
interface JsonOrder {
  clientOrderId: string;
  exchangeOrderId: string | null;
  symbol: string;
  side: Order['side'];
  type: Order['type'];
  status: Order['status'];
  quantity: string;
  filledQuantity: string;
  averagePrice: string | null;
  price: string | null;
  fills: { price: string; quantity: string; fee: string; feeCurrency: FeeCurrency; timestampMs: number | null; executionId?: string | null; feeProductId?: string | null }[];
  fee: string;
  feeCurrency: FeeCurrency;
  reason: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

const VALID_ORDER_STATUS: ReadonlySet<string> = new Set(ORDER_STATUS);

export class OrderStore {
  constructor(private readonly filePath: string) {}

  /** Tri-state load (OK / MISSING / CORRUPT). CORRUPT is never MISSING. */
  load(): LoadResult<OrderLedgerPayload> {
    const r = readEnvelope(this.filePath, 'live', 'order-ledger');
    if (r.status !== 'OK') return r;
    const payload = r.data.payload as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'CORRUPT', reason: 'order ledger payload is not an object' };
    }
    const orders = (payload as { orders?: unknown }).orders;
    if (!orders || typeof orders !== 'object' || Array.isArray(orders)) {
      return { status: 'CORRUPT', reason: 'order ledger is missing its orders map' };
    }
    try {
      for (const [key, value] of Object.entries(orders as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
          return { status: 'CORRUPT', reason: `order "${key}" is not an object` };
        }
        orderFromJson(value as JsonOrder); // throws on invalid Money/enum/status
      }
    } catch (err) {
      return { status: 'CORRUPT', reason: `invalid order ledger entry: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { status: 'OK', data: { orders: orders as Record<string, JsonOrder> } };
  }

  /** All known orders as a Map keyed by clientOrderId. Throws on CORRUPT. */
  allOrders(): Map<string, Order> {
    const ledger = this.loadData();
    const map = new Map<string, Order>();
    if (ledger) {
      for (const [k, v] of Object.entries(ledger.orders)) map.set(k, orderFromJson(v));
    }
    return map;
  }

  /** Look up an order by its local idempotency key. Throws on CORRUPT. */
  get(clientOrderId: string): Order | null {
    const order = this.loadData()?.orders[clientOrderId];
    return order ? orderFromJson(order) : null;
  }

  /** Persist (upsert) an order by its clientOrderId. Refuses to overwrite a corrupt ledger. */
  save(order: Order): void {
    withStateDirLock(dirname(this.filePath), () => {
      const ledger = this.mutableLedger();
      ledger.orders[order.clientOrderId] = orderToJson(order);
      writeEnvelope(this.filePath, 'live', 'order-ledger', { orders: ledger.orders });
    });
  }

  /** Persist several orders at once (atomic). Refuses to overwrite a corrupt ledger. */
  saveAll(orders: Iterable<Order>): void {
    withStateDirLock(dirname(this.filePath), () => {
      const ledger = this.mutableLedger();
      for (const o of orders) ledger.orders[o.clientOrderId] = orderToJson(o);
      writeEnvelope(this.filePath, 'live', 'order-ledger', { orders: ledger.orders });
    });
  }

  /** Hand back all known orders that are not in a terminal state. */
  openLocalOrders(): Order[] {
    const out: Order[] = [];
    for (const o of this.allOrders().values()) {
      if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED' || o.status === 'SUBMITTED' || o.status === 'UNKNOWN') {
        out.push(o);
      }
    }
    return out;
  }

  /** Internal: load data, throwing on CORRUPT and returning null on MISSING. */
  private loadData(): OrderLedgerPayload | null {
    const r = this.load();
    if (r.status === 'CORRUPT') {
      throw new CorruptStateError(`order ledger is corrupt: ${r.reason}`);
    }
    return r.status === 'OK' ? r.data : null;
  }

  /** Internal: a mutable ledger for save(); throws on CORRUPT, empty on MISSING. */
  private mutableLedger(): OrderLedgerPayload {
    const r = this.load();
    if (r.status === 'CORRUPT') {
      // NEVER overwrite a corrupt ledger with an empty one (Defect B).
      throw new CorruptStateError(
        `order ledger is corrupt (${r.reason}); refusing to overwrite it — operator must reconcile`,
      );
    }
    return r.status === 'OK' ? r.data : { orders: {} };
  }
}

function orderToJson(o: Order): JsonOrder {
  return {
    clientOrderId: o.clientOrderId,
    exchangeOrderId: o.exchangeOrderId,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    status: o.status,
    quantity: o.quantity.toString(),
    filledQuantity: o.filledQuantity.toString(),
    averagePrice: o.averagePrice ? o.averagePrice.toString() : null,
    price: o.price ? o.price.toString() : null,
    fills: o.fills.map((f) => ({
      price: f.price.toString(),
      quantity: f.quantity.toString(),
      fee: f.fee.toString(),
      feeCurrency: f.feeCurrency,
      timestampMs: f.timestampMs,
      ...(f.executionId != null ? { executionId: f.executionId } : {}),
      ...(f.feeProductId != null ? { feeProductId: f.feeProductId } : {}),
    })),
    fee: o.fee.toString(),
    feeCurrency: o.feeCurrency,
    reason: o.reason,
    createdAtMs: o.createdAtMs,
    updatedAtMs: o.updatedAtMs,
  };
}

function orderFromJson(j: JsonOrder): Order {
  if (!VALID_ORDER_STATUS.has(j.status)) {
    throw new Error(`invalid order status "${String(j.status)}"`);
  }
  return {
    clientOrderId: j.clientOrderId,
    exchangeOrderId: j.exchangeOrderId,
    symbol: j.symbol,
    side: j.side,
    type: j.type,
    status: j.status,
    quantity: Money.fromString(j.quantity),
    filledQuantity: Money.fromString(j.filledQuantity),
    averagePrice: j.averagePrice ? Money.fromString(j.averagePrice) : null,
    price: j.price ? Money.fromString(j.price) : null,
    fills: j.fills.map<Fill>((f) => ({
      price: Money.fromString(f.price),
      quantity: Money.fromString(f.quantity),
      fee: Money.fromString(f.fee),
      feeCurrency: f.feeCurrency,
      timestampMs: f.timestampMs,
      executionId: f.executionId ?? null,
      ...(f.feeProductId != null ? { feeProductId: f.feeProductId } : {}),
    })),
    fee: Money.fromString(j.fee),
    feeCurrency: j.feeCurrency,
    reason: j.reason,
    createdAtMs: j.createdAtMs,
    updatedAtMs: j.updatedAtMs,
  };
}
