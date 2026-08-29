import { describe, expect, it, vi } from 'vitest';
import { NdaxRestClient, type FetchLike } from '../../../src/exchanges/ndax/restClient.js';
import {
  AuthenticationError,
  InvalidCredentialsError,
  InvalidResponseError,
  NetworkError,
  OrderRejectedError,
  RateLimitError,
  ResourceNotFoundError,
  ServerError,
  TimeoutError,
} from '../../../src/exchanges/errors.js';

function okFetch(body: unknown, status = 200): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function errFetch(body: unknown, status = 400): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const HEADERS = { Nonce: '1234', APIKey: 'k', Signature: 'sig', UserId: '9' };

describe('NdaxRestClient', () => {
  it('posts to baseUrl/endpoint with JSON body', async () => {
    const fetchImpl = okFetch({ result: true });
    const client = new NdaxRestClient({ baseUrl: 'https://api.ndax.io:8443/AP/', fetchImpl, throttleMs: 0 });
    await client.post('SendOrder', { OMSId: 1, OrderType: 2 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://api.ndax.io:8443/AP/SendOrder');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect((init as RequestInit).body).toBe(JSON.stringify({ OMSId: 1, OrderType: 2 }));
  });

  it('sends reads as GET with url-encoded query params', async () => {
    const fetchImpl = okFetch({ result: true });
    const client = new NdaxRestClient({ baseUrl: 'https://x/AP', fetchImpl, throttleMs: 0 });
    await client.get('GetL2Snapshot', { omsId: 1, InstrumentId: 8, Depth: 10 });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe('https://x/AP/GetL2Snapshot?omsId=1&InstrumentId=8&Depth=10');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('url-encodes date strings with spaces', async () => {
    const fetchImpl = okFetch([]);
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl, throttleMs: 0 });
    await client.get('GetTickerHistory', { FromDate: '2026-08-28 12:00:00', ToDate: '2026-08-28 12:05:00' });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('FromDate=2026-08-28%2012%3A00%3A00');
  });

  it('returns the parsed body', async () => {
    const client = new NdaxRestClient({ baseUrl: 'https://x/AP', fetchImpl: okFetch({ bestBid: 1 }), throttleMs: 0 });
    expect(await client.get('GetLevel1', {})).toEqual({ bestBid: 1 });
  });

  it('maps 429 to RateLimitError', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch({}, 429), throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(RateLimitError);
  });

  it('maps 401 to InvalidCredentialsError', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch({}, 401), throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('maps 403 to AuthenticationError (IP restriction)', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch({}, 403), throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps 5xx to ServerError', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch({}, 503), throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(ServerError);
  });

  it('maps 404 to ResourceNotFoundError for public calls', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch('', 404), throttleMs: 0 });
    await expect(client.get('GetInstruments', {})).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('maps 404 to AuthenticationError for authenticated calls', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: errFetch('', 404),
      throttleMs: 0,
      headersProvider: () => HEADERS,
    });
    await expect(client.get('GetAccountPositions', {}, { requiresAuth: true })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps NDAX error tuples to specific errors', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch([20, 'Not Authorized'], 200), throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps errorcode 101 to OrderRejectedError', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: errFetch([101, 'Operation Failed'], 200),
      throttleMs: 0,
    });
    await expect(client.post('SendOrder', {})).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('maps errorcode 104 to ResourceNotFoundError', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: errFetch([104, 'Not Found'], 404), throttleMs: 0 });
    await expect(client.get('GetInstrument', {})).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('maps wrapper object errorcode', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: okFetch({ result: true, errormsg: 'bad', errorcode: 100 }),
      throttleMs: 0,
    });
    await expect(client.get('GetInstrument', {})).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('maps errormsg "This endpoint requires 2FACode" to AuthenticationError', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: okFetch({ result: false, errormsg: 'This endpoint requires 2FACode along with the payload', errorcode: 0 }),
      throttleMs: 0,
    });
    await expect(client.get('GetOpenOrders', {}, { requiresAuth: true })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('maps errormsg "Not_Enough_Funds" to OrderRejectedError', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: okFetch({ result: false, errormsg: 'Not_Enough_Funds', errorcode: 0 }),
      throttleMs: 0,
    });
    await expect(client.post('SendOrder', {})).rejects.toBeInstanceOf(OrderRejectedError);
  });

  it('maps errormsg "Invalid InstrumentId" to ResourceNotFoundError', async () => {
    const client = new NdaxRestClient({
      baseUrl: 'x',
      fetchImpl: okFetch({ result: false, errormsg: 'Invalid InstrumentId: 10000', errorcode: 100 }),
      throttleMs: 0,
    });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('throws TimeoutError when the fetch aborts', async () => {
    const abortedFetch: FetchLike = async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: abortedFetch, timeoutMs: 5, throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(TimeoutError);
  });

  it('maps a thrown fetch error to NetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl, throttleMs: 0 });
    await expect(client.get('GetLevel1', {})).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws AuthenticationError when auth is required but no headers exist', async () => {
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl: okFetch({}), throttleMs: 0, headersProvider: () => null });
    await expect(client.get('GetUserAccounts', {}, { requiresAuth: true })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('attaches auth headers when provided', async () => {
    const fetchImpl = okFetch({ result: true });
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl, throttleMs: 0, headersProvider: () => HEADERS });
    await client.get('GetUserAccounts', {}, { requiresAuth: true });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject(HEADERS);
  });

  it('does not attach auth headers to public calls', async () => {
    const fetchImpl = okFetch({ result: true });
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl, throttleMs: 0, headersProvider: () => HEADERS });
    await client.get('Ping', { omsId: 1 });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty('Nonce');
  });

  it('throttles requests to at least throttleMs apart', async () => {
    const fetchImpl = okFetch({ result: true });
    const client = new NdaxRestClient({ baseUrl: 'x', fetchImpl, throttleMs: 30 });
    const start = Date.now();
    await client.get('Ping', {});
    await client.get('Ping', {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});