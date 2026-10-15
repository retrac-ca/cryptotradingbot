/**
 * NdaxAdapter — autonomous live session honoring at the SendOrder boundary.
 *
 * These exercise the REAL SendOrder network path against a scripted fetch. They
 * never contact a live NDAX host and never place a real order. They prove that a
 * genuine, unexpired `AutonomousLiveSession` is the ONLY thing that arms a
 * LIMIT+IOC placement while `enableOrderPlacement=false` and
 * `supportsOrderPlacement=false`.
 */

import { describe, expect, it, vi } from 'vitest';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import type { FetchLike } from '../../../src/exchanges/ndax/restClient.js';
import { OrderRejectedError } from '../../../src/exchanges/errors.js';
import { Money } from '../../../src/money/Money.js';
import type { NewOrder } from '../../../src/order.js';
import {
  createAutonomousLiveSession,
} from '../../../src/execution/AutonomousLiveSession.js';

const BASE = 'https://api.ndax.io:8443/AP';

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
    if (endpoint in routes) return new Response(JSON.stringify(routes[endpoint]!(params)), { status: 200 });
    return new Response(JSON.stringify({ result: false, errormsg: `no route for ${endpoint}` }), { status: 404 });
  });
  return fn as unknown as FetchLike;
}

function adapter(fetchImpl: FetchLike, enableOrderPlacement = false): NdaxAdapter {
  return new NdaxAdapter({
    credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
    baseUrl: BASE,
    fetchImpl,
    throttleMs: 0,
    enableAuthenticatedReads: true,
    enableOrderPlacement,
    marketOverrides: { 'BTC/CAD': '1' },
  });
}

const IOC_BUY: NewOrder = {
  symbol: 'BTC/CAD',
  side: 'BUY',
  type: 'limit',
  tif: 'IOC',
  price: Money.fromString('110000.00'),
  quantity: Money.fromString('0.001'),
  clientOrderId: 'live-BTCCAD-session',
  reason: 'autonomous',
};

function session(overrides: Partial<Parameters<typeof createAutonomousLiveSession>[0]> = {}) {
  return createAutonomousLiveSession({
    type: 'limit',
    tif: 'IOC',
    sides: ['BUY', 'SELL'],
    maxBaseQuantity: Money.fromString('1'),
    maxQuoteNotional: Money.fromString('1000000'),
    maxSessionQuoteNotional: Money.fromString('1000000'),
    maxSessionOrders: 5,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
}

describe('NdaxAdapter — autonomous session authorization boundary', () => {
  it('permits a LIMIT IOC SendOrder when armed ONLY by a genuine session', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', errormsg: '', OrderId: 321 }) });
    const a = adapter(fetchImpl, false); // general placement DISABLED
    const s = session();
    const res = await a.placeOrder(IOC_BUY, s);
    expect(res.exchangeOrderId).toBe('321');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const body = JSON.parse(String((calls[calls.length - 1]![1] as RequestInit).body));
    expect(body.TimeInForce).toBe(3); // IOC
    expect(body.OrderType).toBe(2); // Limit
    expect(body.LimitPrice).toBe(110000);
  });

  it('refuses a forged/invalid session before any network call', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, false);
    const forged = { kind: 'autonomous-live-session', token: 'nope', scope: {} };
    await expect(a.placeOrder(IOC_BUY, forged as never)).rejects.toBeInstanceOf(OrderRejectedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a MARKET order even with a valid session', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, false);
    const s = session();
    await expect(a.placeOrder({ ...IOC_BUY, type: 'market' }, s)).rejects.toBeInstanceOf(OrderRejectedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes the session order budget at the mutation boundary', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, false);
    const s = session({ maxSessionOrders: 1 });
    await a.placeOrder(IOC_BUY, s);
    await expect(a.placeOrder({ ...IOC_BUY, clientOrderId: 'live-BTCCAD-session-2' }, s)).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('refuses an expired session', async () => {
    const fetchImpl = scriptedFetch({ SendOrder: () => ({ status: 'Accepted', OrderId: 1 }) });
    const a = adapter(fetchImpl, false);
    const s = createAutonomousLiveSession({
      type: 'limit', tif: 'IOC', sides: ['BUY', 'SELL'],
      maxBaseQuantity: Money.fromString('1'), maxQuoteNotional: Money.fromString('1000000'),
      maxSessionQuoteNotional: Money.fromString('1000000'), maxSessionOrders: 5,
      expiresAtMs: Date.now() - 1,
    });
    await expect(a.placeOrder(IOC_BUY, s)).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('still reports supportsOrderPlacement=false', () => {
    expect(adapter(scriptedFetch({}), false).capabilities.supportsOrderPlacement).toBe(false);
  });
});
