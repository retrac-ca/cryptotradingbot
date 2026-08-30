/**
 * NdaxAdapter order placement / cancellation — deterministic wire-path tests.
 *
 * These exercise the real SendOrder/CancelOrder network paths (POST + signed
 * headers + typed error mapping) against a scripted fetch. They never contact a
 * live NDAX host, never place/cancel a real order, and the adapter keeps
 * `supportsOrderPlacement=false` throughout.
 */

import { describe, expect, it, vi } from 'vitest';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import type { FetchLike } from '../../../src/exchanges/ndax/restClient.js';
import {
  AuthenticationError,
  InvalidResponseError,
  NetworkError,
  OrderRejectedError,
  TimeoutError,
} from '../../../src/exchanges/errors.js';
import { Money } from '../../../src/money/Money.js';
import type { NewOrder } from '../../../src/order.js';

const BASE = 'https://api.ndax.io:8443/AP';

/** Route by NDAX endpoint path segment; decode GET query params and POST bodies. */
function scriptedFetch(routes: Record<string, (params: Record<string, unknown>) => unknown>): FetchLike {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const qIdx = href.indexOf('?');
    const path = qIdx === -1 ? href : href.slice(0, qIdx);
    const endpoint = path.slice(path.lastIndexOf('/') + 1);
    let params: Record<string, unknown> = {};
    if (qIdx !== -1) {
      for (const [k, v] of new URLSearchParams(href.slice(qIdx + 1))) params[k] = v;
    }
    if (init?.body) params = JSON.parse(String(init.body));
    if (endpoint in routes) {
      const payload = routes[endpoint]!(params);
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ result: false, errormsg: `no route for ${endpoint}` }), { status: 404 });
  });
  return fn as unknown as FetchLike;
}

function lastCall(fetchImpl: FetchLike): { url: string; init: RequestInit } {
  const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url: String(url), init };
}

const marketBuy: NewOrder = {
  symbol: 'BTC/CAD',
  side: 'BUY',
  type: 'market',
  quantity: Money.fromString('0.00123456'),
  clientOrderId: 'live-BTCCAD-1700000000001-1',
  reason: 'test',
};

const MARKET_OVERRIDES = { 'BTC/CAD': '1' };

function adapter(
  fetchImpl: FetchLike,
  opts: { enableOrderPlacement?: boolean; enableAuthenticatedReads?: boolean; noAccountId?: boolean } = {},
): NdaxAdapter {
  return new NdaxAdapter({
    credentials: opts.noAccountId
      ? { apiKey: 'k', apiSecret: 's', userId: '7' }
      : { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
    baseUrl: BASE,
    fetchImpl,
    throttleMs: 0,
    enableAuthenticatedReads: opts.enableAuthenticatedReads ?? true,
    enableOrderPlacement: opts.enableOrderPlacement ?? true,
    marketOverrides: MARKET_OVERRIDES,
  });
}

describe('NdaxAdapter order placement (SendOrder/CancelOrder network paths)', () => {
  it('sends a signed POST to SendOrder with the mapped market BUY body', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', errormsg: '', OrderId: 123 }) });
    const a = adapter(fetchImpl);
    const res = await a.placeOrder(marketBuy);
    expect(res.clientOrderId).toBe(marketBuy.clientOrderId);
    expect(res.exchangeOrderId).toBe('123');
    expect(res.unknownOutcome).toBe(false);

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/SendOrder`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.APIKey).toBe('k');
    expect(headers.UserId).toBe('7');
    expect(headers.Nonce).toBeTruthy();
    expect(headers.Signature).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      InstrumentId: 1,
      OMSId: 1,
      AccountId: 449,
      TimeInForce: 1,
      ClientOrderId: 0, // non-numeric local id is not forwarded
      OrderIdOCO: 0,
      UseDisplayQuantity: false,
      Side: 0,
      quantity: 0.00123456,
      OrderType: 1,
      PegPriceType: 1,
    });
  });

  it('sends LimitPrice for a limit BUY and does NOT forward the local clientOrderId', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', errormsg: '', OrderId: 5 }) });
    const a = adapter(fetchImpl);
    const limitBuy: NewOrder = {
      ...marketBuy,
      type: 'limit',
      price: Money.fromString('110000.00'),
      tif: 'GTC',
      clientOrderId: '987654321',
    };
    await a.placeOrder(limitBuy);
    const body = JSON.parse(String(lastCall(fetchImpl).init.body)) as Record<string, unknown>;
    expect(body.OrderType).toBe(2);
    expect(body.LimitPrice).toBe(110000);
    expect(body.TimeInForce).toBe(1);
    // The adapter never forwards our local (possibly non-numeric) idempotency
    // key to NDAX: duplicate protection stays in the local OrderStore.
    expect(body.ClientOrderId).toBe(0);
  });

  it('resolves the account id via GetUserAccounts when none was configured', async () => {
    const fetchImpl = scriptedFetch({
      GetUserAccounts: () => [771],
      SendOrder: () => ({ status: 'Accepted', errormsg: '', OrderId: 1 }),
    });
    const a = adapter(fetchImpl, { noAccountId: true });
    await a.placeOrder(marketBuy);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    // requireAuth() issues GetUserAccounts first; then SendOrder is posted.
    expect(String(calls[0]![0])).toContain('GetUserAccounts');
    const body = JSON.parse(String(calls[1]![1].body)) as Record<string, unknown>;
    expect(body.AccountId).toBe(771);
  });

  it('throws OrderRejectedError when SendOrder rejects (definite failure)', async () => {
    const fetchImpl = scriptedFetch({
      SendOrder: () => ({ status: 'Rejected', errormsg: 'Not_Enough_Funds', OrderId: 0 }),
    });
    await expect(adapter(fetchImpl).placeOrder(marketBuy)).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('fails closed (ambiguous InvalidResponseError) when the SendOrder ack is malformed', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ result: true }) });
    await expect(adapter(fetchImpl).placeOrder(marketBuy)).rejects.toBeInstanceOf(InvalidResponseError);
    const fetchImpl2 = scriptedFetch({ SendOrder: () => ({ status: 'Maybe', OrderId: 9 }) });
    await expect(adapter(fetchImpl2).placeOrder(marketBuy)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('surfaces network failure as NetworkError (ambiguous, reconcile-before-retry)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as FetchLike;
    await expect(adapter(fetchImpl).placeOrder(marketBuy)).rejects.toBeInstanceOf(NetworkError);
  });

  it('surfaces an abort/timeout as TimeoutError (ambiguous)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as FetchLike;
    await expect(adapter(fetchImpl).placeOrder(marketBuy)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('refuses to place when order placement is disabled (default), before any network call', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, { enableOrderPlacement: false });
    await expect(a.placeOrder(marketBuy)).rejects.toBeInstanceOf(OrderRejectedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires authenticated reads to be enabled even when placement is armed', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, { enableAuthenticatedReads: false });
    await expect(a.placeOrder(marketBuy)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('keeps supportsOrderPlacement=false even while the wire path is armed', () => {
    const a = adapter(scriptedFetch({}), { enableOrderPlacement: true });
    expect(a.capabilities.supportsOrderPlacement).toBe(false);
  });

  // ---- CancelOrder ----

  it('sends a signed POST to CancelOrder; the ack is receipt-only (orderStatus null)', async () => {
    const fetchImpl = scriptedFetch({ CancelOrder: () => ({ result: true, errormsg: '', errorcode: 0, detail: '' }) });
    const a = adapter(fetchImpl);
    const res = await a.cancelOrder('BTC/CAD', '123');
    expect(res.acknowledged).toBe(true);
    expect(res.orderStatus).toBe(null); // NOT proof of cancellation

    const { url, init } = lastCall(fetchImpl);
    expect(url).toBe(`${BASE}/CancelOrder`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ OMSId: 1, AccountId: 449, OrderId: 123 });
  });

  it('maps an explicit CancelOrder failure response to a thrown error (definite)', async () => {
    const fetchImpl = scriptedFetch({
      CancelOrder: () => ({ result: false, errormsg: 'Operation Failed', errorcode: 101, detail: '' }),
    });
    await expect(adapter(fetchImpl).cancelOrder('BTC/CAD', '123')).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('maps a bare result:false CancelOrder response to acknowledged:false (not confirmed)', async () => {
    const fetchImpl = scriptedFetch({ CancelOrder: () => ({ result: false }) });
    const res = await adapter(fetchImpl).cancelOrder('BTC/CAD', '123');
    expect(res.acknowledged).toBe(false);
    expect(res.orderStatus).toBe(null);
  });

  it('refuses to cancel when order placement is disabled, before any network call', async () => {
    const fetchImpl = scriptedFetch({ CancelOrder: () => ({ result: true }) });
    const a = adapter(fetchImpl, { enableOrderPlacement: false });
    await expect(a.cancelOrder('BTC/CAD', '123')).rejects.toBeInstanceOf(OrderRejectedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});