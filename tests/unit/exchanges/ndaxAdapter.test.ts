import { describe, expect, it, vi } from 'vitest';
import { NdaxAdapter } from '../../../src/exchanges/ndax/NdaxAdapter.js';
import type { FetchLike } from '../../../src/exchanges/ndax/restClient.js';
import { ndaxSignature } from '../../../src/exchanges/ndax/signing.js';
import { ymdhms } from '../../../src/exchanges/ndax/mappings.js';
import { AuthenticationError, OrderRejectedError, ResourceNotFoundError } from '../../../src/exchanges/errors.js';
import type { NewOrder } from '../../../src/order.js';

const BASE = 'https://api.ndax.io:8443/AP';

/**
 * A scripted fetch that routes by the NDAX endpoint path segment, decoding GET
 * query params and POST bodies, so the adapter test never touches a real NDAX
 * host.
 */
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

const buyOrder = { symbol: 'BTC/CAD' } as NewOrder;

const INSTRUMENT = {
  symbol: 'BTCCAD',
  instrumentId: 1,
  product1Symbol: 'BTC',
  product2Symbol: 'CAD',
  priceIncrement: 0.01,
  quantityIncrement: 0.00000001,
};

describe('NdaxAdapter', () => {
  it('fetches a ticker via GetLevel1 (GET, capitalized keys)', async () => {
    const fetchImpl = scriptedFetch({
      GetLevel1: () => ({ BestBid: 88100.5, BestOffer: 88101.25, LastTradedPx: 88100.75, TimeStamp: '1700000000000' }),
    });
    const adapter = new NdaxAdapter({ credentials: { apiKey: '', apiSecret: '', userId: '' }, baseUrl: BASE, fetchImpl, throttleMs: 0, marketOverrides: { 'BTC/CAD': '1' } });
    const ticker = await adapter.getTicker('BTC/CAD');
    expect(ticker.timestampMs).toBe(1700000000000);
    expect(ticker.bid!.toFixed(2)).toBe('88100.50');
    expect(ticker.ask!.toFixed(2)).toBe('88101.25');
    expect(lastCall(fetchImpl).init.method).toBe('GET');
  });

  it('loads and caches markets from GetInstruments', async () => {
    const fetchImpl = scriptedFetch({ GetInstruments: () => [INSTRUMENT] });
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    const markets = await adapter.getMarkets();
    expect(markets.length).toBe(1);
    expect(markets[0]!.symbol).toBe('BTC/CAD');
    // second call uses cache, no extra fetch
    const again = await adapter.getMarkets();
    expect(again.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('requests candles with "YYYY-MM-DD HH:MM:SS" FromDate/ToDate', async () => {
    const fetchImpl = scriptedFetch({ GetTickerHistory: () => [] });
    const adapter = new NdaxAdapter({ credentials: { apiKey: '', apiSecret: '', userId: '' }, baseUrl: BASE, fetchImpl, throttleMs: 0, marketOverrides: { 'BTC/CAD': '1' } });
    await adapter.getCandles('BTC/CAD', '5m', { fromMs: 1700000000000, toMs: 1700000003000 });
    const { url } = lastCall(fetchImpl);
    expect(url).toContain('FromDate=' + encodeURIComponent(ymdhms(1700000000000)));
    expect(url).toContain('Interval=300');
  });

  it('throws when order placement is disabled', async () => {
    const fetchImpl = scriptedFetch({});
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    await expect(adapter.placeOrder(buyOrder)).rejects.toBeInstanceOf(OrderRejectedError);
    await expect(adapter.cancelOrder('BTC/CAD', '1')).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('blocks authenticated reads unless explicitly enabled', async () => {
    const fetchImpl = scriptedFetch({});
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    await expect(adapter.getBalances()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps a missing market to ResourceNotFoundError for ticker', async () => {
    const fetchImpl = scriptedFetch({ GetInstruments: () => [] });
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    await expect(adapter.getTicker('ETH/USDT')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('reports health based on Ping result', async () => {
    const fetchImpl = scriptedFetch({ Ping: () => ({ result: true }) });
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    const health = await adapter.health();
    expect(health.connected).toBe(true);
    expect(typeof health.latencyMs).toBe('number');
  });

  it('reports unhealthy when Ping fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchLike;
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    const health = await adapter.health();
    expect(health.connected).toBe(false);
  });

  it('advertises that order placement is NOT enabled', async () => {
    const fetchImpl = scriptedFetch({});
    const adapter = new NdaxAdapter({ credentials: { apiKey: 'k', apiSecret: 's', userId: '1' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    expect(adapter.capabilities.supportsOrderPlacement).toBe(false);
  });

  it('advertises that public data does NOT require auth', async () => {
    const fetchImpl = scriptedFetch({});
    const adapter = new NdaxAdapter({ credentials: { apiKey: '', apiSecret: '', userId: '' }, baseUrl: BASE, fetchImpl, throttleMs: 0 });
    expect(adapter.capabilities.publicDataRequiresAuth).toBe(false);
  });

  it('sends private reads as GET with signed headers (no session token)', async () => {
    const fetchImpl = scriptedFetch({
      GetInstruments: () => [INSTRUMENT],
      GetUserAccounts: () => [449],
      GetOpenOrders: () => [],
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'mykey', apiSecret: 'mysecret', userId: '7', nonce: '1234567890123' },
      baseUrl: BASE,
      fetchImpl,
      enableAuthenticatedReads: true,
      throttleMs: 0,
    });
    await adapter.getOpenOrders();
    // GetOpenOrders call (there may be a GetInstruments call first, from the
    // symbol resolver).
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
    const openOrdersCall = calls.find(([u]) => String(u).includes('GetOpenOrders'))!;
    const [url, init] = openOrdersCall;
    expect(init.method).toBe('GET');
    expect(url).toContain('omsId=1');
    expect(url).toContain('AccountId=449');
    const headers = init.headers as Record<string, string>;
    expect(headers.APIKey).toBe('mykey');
    expect(headers.UserId).toBe('7');
    expect(headers.Nonce).toBe('1234567890123');
    expect(headers.Signature).toBe(ndaxSignature('mysecret', '1234567890123', '7', 'mykey'));
  });

  it('resolves the account id from GetUserAccounts (array of ints)', async () => {
    const fetchImpl = scriptedFetch({
      GetUserAccounts: () => [449],
      GetAccountPositions: () => [{ ProductSymbol: 'BTC', Amount: 0.5, Hold: 0.1 }],
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7' },
      baseUrl: BASE,
      fetchImpl,
      enableAuthenticatedReads: true,
      throttleMs: 0,
    });
    const balances = await adapter.getBalances();
    expect(balances.length).toBe(1);
    expect(balances[0]!.currency).toBe('BTC');
    expect(balances[0]!.total.toFixed(2)).toBe('0.50');
    expect(balances[0]!.available.toFixed(2)).toBe('0.40');
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    expect(String(calls[0]![0])).toContain('GetUserAccounts');
    expect(String(calls[0]![0])).toContain('UserName=');
    expect(String(calls[1]![0])).toContain('AccountId=449');
  });

  it('uses an explicit accountId without calling GetUserAccounts', async () => {
    const fetchImpl = scriptedFetch({
      GetAccountPositions: () => [],
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: BASE,
      fetchImpl,
      enableAuthenticatedReads: true,
      throttleMs: 0,
    });
    await adapter.getBalances();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('resolves order symbols from instrument ids via markets cache', async () => {
    const fetchImpl = scriptedFetch({
      GetInstruments: () => [INSTRUMENT],
      GetOpenOrders: () => [
        {
          OrderId: 55, Side: 'Buy', OrderType: 'Limit', OrderState: 'Working', Instrument: 1,
          OrigQuantity: 0.5, QuantityExecuted: 0.1, Price: 88000, AvgPrice: 0,
          ClientOrderId: 123, ReceiveTime: 1700000000000, LastUpdatedTime: 1700000000000,
        },
      ],
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: BASE,
      fetchImpl,
      enableAuthenticatedReads: true,
      throttleMs: 0,
    });
    const orders = await adapter.getOpenOrders('BTC/CAD');
    expect(orders.length).toBe(1);
    const o = orders[0]!;
    expect(o.symbol).toBe('BTC/CAD');
    expect(o.side).toBe('BUY');
    expect(o.type).toBe('limit');
    expect(o.status).toBe('OPEN');
    expect(o.clientOrderId).toBe('123');
    expect(o.quantity.toFixed(2)).toBe('0.50');
    expect(o.filledQuantity.toFixed(2)).toBe('0.10');
  });

  it('reads account trades via GetAccountTrades (GET, maps execution/trade/fee ids) and filters by symbol', async () => {
    const fetchImpl = scriptedFetch({
      GetInstruments: () => [INSTRUMENT],
      GetAccountTrades: () => [
        {
          ExecutionId: 111, TradeId: 222, OrderId: 42, AccountId: 449, SubAccountId: 0,
          ClientOrderId: 0, InstrumentId: 1, Side: 'Buy', Quantity: 0.5, RemainingQuantity: 0,
          Price: 88000.5, Value: 44000.25, TradeTimeMS: 1700000000000, Fee: 10.5, FeeProductId: 2,
          OrderOriginator: 'api',
        },
        {
          ExecutionId: 333, TradeId: 444, OrderId: 43, AccountId: 449, SubAccountId: 0,
          ClientOrderId: 0, InstrumentId: 2, Side: 'Sell', Quantity: 0.1, RemainingQuantity: 0,
          Price: 90000, Value: 9000, TradeTimeMS: 1700000001000, Fee: 2.0, FeeProductId: 9,
          OrderOriginator: 'api',
        },
      ],
    });
    const adapter = new NdaxAdapter({
      credentials: { apiKey: 'k', apiSecret: 's', userId: '7', accountId: 449 },
      baseUrl: BASE,
      fetchImpl,
      enableAuthenticatedReads: true,
      throttleMs: 0,
    });
    const all = await adapter.getAccountTrades();
    expect(all.length).toBe(2);
    expect(all[0]!.executionId).toBe('111');
    expect(all[0]!.tradeId).toBe('222');
    expect(all[0]!.orderId).toBe('42');
    expect(all[0]!.symbol).toBe('BTC/CAD');
    expect(all[0]!.side).toBe('BUY');
    expect(all[0]!.feeProductId).toBe('2');
    expect(all[1]!.symbol).toBeNull(); // instrument 2 not in the resolver => null, never guessed
    expect(all[1]!.side).toBe('SELL');
    // symbol filter narrows to the BTC/CAD market.
    const btc = await adapter.getAccountTrades('BTC/CAD');
    expect(btc.length).toBe(1);
    expect(btc[0]!.executionId).toBe('111');
    // request was a GET with the documented params.
    const { init, url } = lastCall(fetchImpl);
    expect(init.method).toBe('GET');
    expect(url).toContain('GetAccountTrades');
    expect(url).toContain('OMSId=1');
    expect(url).toContain('AccountId=449');
    expect(url).toContain('StartIndex=0');
    expect(url).toContain('Count=200');
  });
});