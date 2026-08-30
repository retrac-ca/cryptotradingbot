/**
 * OrderStore — durable record of every order the bot has tried to place.
 *
 * Persisting an order keyed by its local `clientOrderId` BEFORE submission is
 * what makes duplicate-order prevention and restart recovery possible: no matter
 * what happens (crash, timeout, restart), we can always look up whether an order
 * with a given key was already attempted, and reconcile with the exchange rather
 * than blindly re-submitting.
 *
 * Like `PaperStateStore`, this is a minimal atomic JSON file. The exchange
 * remains authoritative for actual balances/orders; this store is the bot's own
 * ledger of intent and observed outcomes.
 *
 * Serialization: `Money` values are stored as decimal strings (exact) and
 * rebuilt on read, so no BigInt ever reaches JSON.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { Money } from '../money/Money.js';
import type { Fill, Order } from '../order.js';

export interface OrderLedgerV1 {
  version: 1;
  /** Orders keyed by clientOrderId (Money fields stored as decimal strings). */
  orders: Record<string, JsonOrder>;
  savedAtMs: number;
}

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
  fills: { price: string; quantity: string; fee: string; feeCurrency: 'base' | 'quote'; timestampMs: number }[];
  fee: string;
  feeCurrency: 'base' | 'quote';
  reason: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export class OrderStore {
  constructor(private readonly filePath: string) {}

  /** Load the order ledger, or null if none exists yet / unreadable. */
  load(): OrderLedgerV1 | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const json = JSON.parse(raw) as OrderLedgerV1;
      if (json.version !== 1) return null;
      return json;
    } catch {
      return null;
    }
  }

  /** All known orders as a Map keyed by clientOrderId. */
  allOrders(): Map<string, Order> {
    const ledger = this.load();
    const map = new Map<string, Order>();
    if (ledger) {
      for (const [k, v] of Object.entries(ledger.orders)) map.set(k, orderFromJson(v));
    }
    return map;
  }

  /** Look up an order by its local idempotency key. */
  get(clientOrderId: string): Order | null {
    const order = this.load()?.orders[clientOrderId];
    return order ? orderFromJson(order) : null;
  }

  /** Persist (upsert) an order by its clientOrderId. Atomic write. */
  save(order: Order): void {
    const ledger = this.load() ?? { version: 1 as const, orders: {}, savedAtMs: 0 };
    ledger.orders[order.clientOrderId] = orderToJson(order);
    ledger.savedAtMs = Date.now();
    this.write(ledger);
  }

  /** Persist several orders at once (atomic). */
  saveAll(orders: Iterable<Order>): void {
    const ledger = this.load() ?? { version: 1 as const, orders: {}, savedAtMs: 0 };
    for (const o of orders) ledger.orders[o.clientOrderId] = orderToJson(o);
    ledger.savedAtMs = Date.now();
    this.write(ledger);
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

  private write(ledger: OrderLedgerV1): void {
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    renameSync(tmp, this.filePath);
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
    })),
    fee: o.fee.toString(),
    feeCurrency: o.feeCurrency,
    reason: o.reason,
    createdAtMs: o.createdAtMs,
    updatedAtMs: o.updatedAtMs,
  };
}

function orderFromJson(j: JsonOrder): Order {
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
    })),
    fee: Money.fromString(j.fee),
    feeCurrency: j.feeCurrency,
    reason: j.reason,
    createdAtMs: j.createdAtMs,
    updatedAtMs: j.updatedAtMs,
  };
}
