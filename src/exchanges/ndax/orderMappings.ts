/**
 * Pure mapping functions for NDAX order submission / cancellation.
 *
 * These encode the DOCUMENTED NDAX SendOrder / CancelOrder request shapes and
 * their responses (apidoc.ndax.io, v3.3). They are pure and deterministic so
 * they can be unit-tested against fixed fixtures and reviewed in isolation.
 * They perform NO I/O and are NOT wired to any live order-placement path while
 * `supportsOrderPlacement` is false — enabling live trading must be a separate,
 * explicit, human-reviewed decision.
 *
 * Verified vs inferred vs unknown is tracked in docs/NDAX_API.md (§6, and the
 * "what is required before enabling" summary). Anything uncertain is surfaced
 * here as an explicit assumption so it can be corrected in one place.
 *
 * Critical verified points (apidoc.ndax.io):
 *   - SendOrder is ASYNCHRONOUS: the response only records whether the request
 *     was Accepted/Rejected and returns the server `OrderId`; it does NOT
 *     confirm the order reached the book. Reconciliation (GetOrderStatus /
 *     GetOpenOrders) is required to confirm a working order.
 *   - CancelOrder is synchronous but its response only confirms RECEIPT, not
 *     that the order was canceled. Confirm via GetOrderStatus/GetOpenOrders.
 *   - NDAX `ClientOrderId` is a LONG INTEGER, and the doc warns it "may not be
 *     unique". It is therefore NOT a reliable cross-process idempotency key.
 *     Our duplicate-order protection comes from the local OrderStore
 *     (persist-before-submit) plus reconcile-before-retry, NOT from NDAX.
 *
 * String vs integer caveat: NDAX `quantity` is shown lowercase in the official
 * request example while the field table capitalizes it (`Quantity`). We use the
 * lowercase example form (`quantity`); this is explicit and flagged as an
 * UNVERIFIED detail that must be confirmed on a live account before enabling.
 */

import type { CancelResult, PlaceOrderResult } from '../ExchangeAdapter.js';
import type { NewOrder, OrderTif, OrderType } from '../../order.js';
import type { MarketInfo } from '../../types.js';
import { OrderRejectedError, InvalidResponseError } from '../errors.js';

export const NDAX_OMS_ID = 1;

export type NdaxSide = 0 | 1; // 0 Buy, 1 Sell
export type NdaxOrderType = 1 | 2; // 1 Market, 2 Limit
export type NdaxTimeInForce = 1 | 3 | 4; // 1 GTC, 3 IOC, 4 FOK
export type NdaxPegPriceType = 1 | 2 | 3 | 4; // 1 Last, 2 Bid, 3 Ask, 4 Midpoint

/** Map canonical order type to the NDAX integer enum (V1 supports market/limit). */
export function toNdaxOrderType(type: OrderType): NdaxOrderType {
  switch (type) {
    case 'market': return 1;
    case 'limit': return 2;
  }
}

/** Map canonical TimeInForce to the NDAX integer enum. Defaults to GTC (1). */
export function toNdaxTimeInForce(tif: OrderTif | undefined): NdaxTimeInForce {
  switch (tif) {
    case 'IOC': return 3;
    case 'FOK': return 4;
    case 'GTC': return 1;
    default: return 1; // NDAX default is GTC
  }
}

/**
 * NDAX `ClientOrderId` is a long integer. Our local idempotency key is an
 * arbitrary string, so by default we send 0 (NDAX's "unset" value) and rely on
 * the local OrderStore for duplicate protection. If the caller supplies a
 * numeric client order id, it is forwarded (useful for recognizing the order in
 * NDAX reads). Throws if a non-zero non-numeric value is supplied.
 */
export function toNdaxClientOrderId(clientOrderId: string, forward?: boolean): number {
  if (!forward) return 0;
  if (!/^\d+$/.test(clientOrderId)) {
    throw new Error(
      `NDAX ClientOrderId must be an integer (got "${clientOrderId}"). ` +
        'Use a numeric clientOrderId if you need NDAX-side order recognition.',
    );
  }
  return Number(clientOrderId);
}

/**
 * Compose the SendOrder request body from a canonical NewOrder + resolved
 * instrument id + account id. Pure and network-free.
 */
export function toNdaxSendOrderRequest(
  order: NewOrder,
  market: MarketInfo,
  accountId: number,
  opts: { timeInForce?: OrderTif; forwardClientOrderId?: boolean } = {},
): Record<string, unknown> {
  const instrumentId = market.exchangeId === '' ? NaN : Number(market.exchangeId);
  if (!Number.isFinite(instrumentId)) {
    throw new Error(`NDAX: cannot map symbol ${order.symbol} to an instrument id`);
  }
  const body: Record<string, unknown> = {
    InstrumentId: instrumentId,
    OMSId: NDAX_OMS_ID,
    AccountId: accountId,
    TimeInForce: toNdaxTimeInForce(opts.timeInForce ?? order.tif),
    ClientOrderId: toNdaxClientOrderId(order.clientOrderId, opts.forwardClientOrderId),
    OrderIdOCO: 0,
    UseDisplayQuantity: false,
    Side: order.side === 'BUY' ? 0 : 1,
    quantity: order.quantity.toNumber(),
    OrderType: toNdaxOrderType(order.type),
    PegPriceType: 1, // only relevant for stop/trailing; harmless and documented default
  };
  if (order.type === 'limit') {
    if (!order.price) throw new Error('NDAX: limit order requires a price');
    body.LimitPrice = order.price.toNumber();
  } else {
    // Market orders must not send a LimitPrice.
    delete body.LimitPrice;
  }
  return body;
}

/** Compose the CancelOrder request body. Confirmation must come from GetOrderStatus/GetOpenOrders. */
export function toNdaxCancelOrderRequest(
  exchangeOrderId: string,
  accountId: number,
): Record<string, unknown> {
  if (!/^\d+$/.test(exchangeOrderId)) {
    throw new Error(`NDAX: exchangeOrderId "${exchangeOrderId}" is not a numeric OrderId`);
  }
  return {
    OMSId: NDAX_OMS_ID,
    AccountId: accountId,
    OrderId: Number(exchangeOrderId),
  };
}

/**
 * Map the SendOrder response into a PlaceOrderResult.
 *
 * The documented response is `{ status, errormsg, OrderId }` where status is
 * "Accepted" or "Rejected" — it only confirms RECEIPT, not placement, so the
 * returned result is an "acknowledged" outcome; the engine still reconciles to
 * confirm a working order on the book.
 */
export function mapSendOrderResponse(raw: unknown): PlaceOrderResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidResponseError(`NDAX SendOrder returned unexpected shape: ${JSON.stringify(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status.toLowerCase() : '';
  const errormsg = typeof r.errormsg === 'string' ? r.errormsg : '';
  if (status === 'rejected') {
    throw new OrderRejectedError(`NDAX SendOrder rejected: ${errormsg || 'unknown reason'}`);
  }
  if (status !== 'accepted') {
    // A missing/unrecognized status means we cannot parse the ack. The order may
    // or may not have been accepted => AMBIGUOUS: fail closed, reconcile.
    throw new InvalidResponseError(
      `NDAX SendOrder returned an unrecognized status (${JSON.stringify(raw)}); ` +
        'outcome is ambiguous, reconcile before acting',
    );
  }
  const orderId = r.OrderId ?? r.orderid;
  return {
    clientOrderId: '',
    exchangeOrderId: orderId != null ? String(orderId) : null,
    unknownOutcome: false,
  };
}

/**
 * Map the CancelOrder response into a CancelResult. The documented response
 * (`result/errormsg/errorcode/detail`) only confirms RECEIPT, so `acknowledged`
 * reflects receipt and `orderStatus` stays null — callers must confirm the
 * canceled state via GetOrderStatus/GetOpenOrders.
 */
export function mapCancelOrderResponse(raw: unknown): CancelResult {
  if (typeof raw !== 'object' || raw === null || raw === undefined) {
    throw new InvalidResponseError(`NDAX CancelOrder returned unexpected shape: ${JSON.stringify(raw)}`);
  }
  const accepted = (raw as Record<string, unknown>).result !== false;
  return { acknowledged: accepted, orderStatus: null };
}
