/**
 * Pure mapping functions converting NDAX wire payloads into canonical domain
 * types. Kept free of I/O so they are easy to unit test against sample NDAX
 * payloads.
 */

import { Money } from '../../money/Money.js';
import type {
  AssetProduct,
  AssetProductType,
  Candle,
  MarketInfo,
  OrderBook,
  OrderBookLevel,
  Ticker,
  Timeframe,
} from '../../types.js';
import type { Fill, Order, OrderSide, OrderStatus, OrderType } from '../../order.js';

/**
 * Convert an NDAX numeric field to Money.
 *
 * NDAX returns prices and quantities as JSON numbers with full decimal
 * precision (e.g. `88123.45`), matching the widely used CCXT connector which
 * reads them directly without scaling. Parse as a decimal string (robust for
 * both `"8800.5"` and `8800.5`, and for `1e-8` scientific notation). If a field
 * proves to be a scaled integer, adjust here in one place. `decimalPlaces` is
 * provided only as an informational hint from `GetProducts` and is not applied
 * to the value until precision is verified.
 */
export function scaledStrToMoney(v: unknown, _decimalPlaces = 8): Money {
  if (v === null || v === undefined || v === '') return Money.zero();
  // JSON may serialize small numbers in scientific notation (e.g. 1e-8 for
  // 0.00000001). NDAX values never exceed 8 decimals, so render numbers with
  // toFixed(8) to avoid 'e' notation before parsing.
  const text = typeof v === 'number' ? v.toFixed(8) : String(v);
  return Money.fromString(text);
}

const SIDE_MAP_NUM: Record<number, OrderSide> = { 0: 'BUY', 1: 'SELL' };
const SIDE_MAP_STR: Record<string, OrderSide> = { buy: 'BUY', sell: 'SELL' };
const ORDER_TYPE_MAP_NUM: Record<number, OrderType> = { 1: 'market', 2: 'limit' };
const ORDER_TYPE_MAP_STR: Record<string, OrderType> = { market: 'market', limit: 'limit' };
const ORDER_STATE_MAP_NUM: Record<number, OrderStatus> = {
  1: 'OPEN', // working
  2: 'REJECTED',
  3: 'CANCELED',
  4: 'EXPIRED',
  5: 'FILLED', // fully executed
};
// NDAX REST returns OrderState / Side / OrderType as STRINGS (verified in the
// production CCXT connector); WS payloads use integers. Support both.
const ORDER_STATE_MAP_STR: Record<string, OrderStatus> = {
  accepted: 'OPEN',
  working: 'OPEN',
  rejected: 'REJECTED',
  canceled: 'CANCELED',
  cancelled: 'CANCELED',
  expired: 'EXPIRED',
  fullyexecuted: 'FILLED',
  partiallyfilled: 'PARTIALLY_FILLED',
  partialfill: 'PARTIALLY_FILLED',
};

/**
 * NDAX returns capitalized camelCase keys on the wire (e.g. `BestBid`,
 * `MinimumQuantity`, `OrderState`). Normalize to lowercase so mappers are
 * case-insensitive and robust to either casing style.
 */
function lowerKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sideOf(v: unknown): OrderSide {
  if (typeof v === 'number') return SIDE_MAP_NUM[v] ?? 'BUY';
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return SIDE_MAP_NUM[Number(v)] ?? 'BUY';
    return SIDE_MAP_STR[v.toLowerCase()] ?? 'BUY';
  }
  return 'BUY';
}

function orderTypeOf(v: unknown): OrderType {
  if (typeof v === 'number') return ORDER_TYPE_MAP_NUM[v] ?? 'market';
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return ORDER_TYPE_MAP_NUM[Number(v)] ?? 'market';
    return ORDER_TYPE_MAP_STR[v.toLowerCase()] ?? 'market';
  }
  return 'market';
}

function orderStateOf(v: unknown): OrderStatus {
  if (typeof v === 'number') return ORDER_STATE_MAP_NUM[v] ?? 'UNKNOWN';
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return ORDER_STATE_MAP_NUM[Number(v)] ?? 'UNKNOWN';
    return ORDER_STATE_MAP_STR[v.toLowerCase()] ?? 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/**
 * Map a GetLevel1 payload into a Ticker.
 * NDAX numeric fields carry full decimal precision; we scale to Money.
 */
export function mapLevel1ToTicker(symbol: string, raw: Record<string, unknown>): Ticker {
  const r = lowerKeys(raw);
  const pick = (k: string): Money => scaledStrToMoney(r[k], 8);
  return {
    symbol,
    // Keys looked up lowercase (lowerKeys lowercases the wire's capitalized keys).
    bid: pick('bestbid'),
    ask: pick('bestoffer'),
    last: pick('lasttradedpx'),
    open: pick('sessionopen'),
    high: pick('sessionhigh'),
    low: pick('sessionlow'),
    baseVolume: pick('rolling24hrvolume'),
    quoteVolume: null,
    // F-3: the exchange timestamp is authoritative. If NDAX provides no usable
    // `TimeStamp`/`LastTradeTime`, the ticker's timestamp is `null` (freshness
    // fails closed) — NEVER a fabricated local `Date.now()` value.
    timestampMs: exchangeEpochMs(r.timestamp ?? r.lasttradetime),
  };
}

/**
 * Interpret an NDAX epoch timestamp field. Returns a valid positive ms epoch
 * only when the input is actually usable; otherwise `null` (missing/malformed).
 * `0`, negative, NaN, Infinity, and non-numeric values all fail closed.
 */
export function exchangeEpochMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return isValidEpochMs(n) ? n : null;
}

/** True for a usable positive finite epoch-ms value. */
function isValidEpochMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Map a GetL2Snapshot payload (array of arrays) into an OrderBook.
 * Row: [MDUpdateId, AccountId, ActionDateTime, ActionType, LastTradePrice,
 *       OrderId, Price, ProductPairCode, Quantity, Side]
 * Side: 0 Buy, 1 Sell.
 */
export function mapL2ToOrderBook(symbol: string, rows: unknown[][]): OrderBook {
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  let quoteTimestampMs: number | undefined;
  for (const row of rows) {
    const price = scaledStrToMoney(row[6], 8);
    const quantity = scaledStrToMoney(row[8], 8);
    const side = Number(row[9]);
    const act = Number(row[2]);
    if (Number.isFinite(act) && act > 0 && (quoteTimestampMs === undefined || act > quoteTimestampMs)) {
      quoteTimestampMs = act;
    }
    if (side === 0) bids.push({ price, quantity });
    else if (side === 1) asks.push({ price, quantity });
  }
  // Sort bids descending (best first), asks ascending (best first).
  bids.sort((a, b) => (b.price.compareTo(a.price) as number));
  asks.sort((a, b) => (a.price.compareTo(b.price) as number));
  // F-3: `timestampMs` is the exchange quote time (newest ActionDateTime), never a
  // fabricated local `Date.now()`. `null` when the exchange provides none. The
  // local observation time is tracked separately via `observedAtMs`.
  return {
    symbol,
    timestampMs: quoteTimestampMs ?? null,
    bids,
    asks,
    ...(quoteTimestampMs !== undefined ? { quoteTimestampMs } : {}),
  };
}

/**
 * Map a GetTickerHistory row to a Candle.
 * Row: [DateTime(ms POSIX), High, Low, Open, Close, Volume, InsideBid, InsideAsk, InstrumentId]
 */
export function mapTickerHistoryRow(symbol: string, timeframe: Timeframe, row: unknown[]): Candle {
  return {
    symbol,
    timeframe,
    timestampMs: Number(row[0]),
    open: scaledStrToMoney(row[3], 8),
    high: scaledStrToMoney(row[1], 8),
    low: scaledStrToMoney(row[2], 8),
    close: scaledStrToMoney(row[4], 8),
    baseVolume: scaledStrToMoney(row[5], 8),
  };
}

/** Convert an NDAX `symbol` like "BTCCAD" to canonical "BTC/CAD". */
export function ndaxSymbolToCanonical(symRaw: unknown): string | null {
  const sym = String(symRaw ?? '');
  // Split the last run of uppercase into the base vs quote when a known quote
  // suffix is present. Simple heuristic: strip known quote currencies.
  const quotes = ['CAD', 'USD', 'USDT', 'BTC', 'ETH', 'USDC', 'EUR', 'GBP', 'JPY', 'AUD'];
  for (const q of quotes) {
    if (sym.endsWith(q) && sym.length > q.length) {
      const base = sym.slice(0, sym.length - q.length);
      return `${base}/${q}`;
    }
  }
  return null;
}

export function canonicalToNdaxSymbol(symbol: string): string {
  return symbol.replace('/', '');
}

export function mapInstrumentToMarketInfo(raw: Record<string, unknown>): MarketInfo {
  const r = lowerKeys(raw);
  const symbolCanon = ndaxSymbolToCanonical(r.symbol);
  if (!symbolCanon) {
    throw new Error(`NDAX: cannot resolve symbol "${String(r.symbol)}" to canonical base/quote`);
  }
  const priceTick = scaledStrToMoney(r.priceincrement, 8);
  const quantityTick = scaledStrToMoney(r.quantityincrement, 8);
  const minOrderBase = 'minimumquantity' in r ? scaledStrToMoney(r.minimumquantity, 8) : null;
  // NOTE: do NOT map `MinimumPrice` to minOrderQuote. Live data shows NDAX
  // sends a per-instrument PRICE FLOOR here (e.g. 25000 for BTCCAD), which is
  // not a minimum order notional and would wrongly block small orders.
  const minOrderQuote: Money | null = null;
  const info: MarketInfo = {
    symbol: symbolCanon,
    exchangeId: String(r.instrumentid ?? ''),
    priceTick: priceTick.isZero() ? Money.fromString('0.01') : priceTick,
    basePrecision: 8,
    quotePrecision: 8,
    quantityTick: quantityTick.isZero() ? Money.fromString('0.00000001') : quantityTick,
    minOrderBase,
    minOrderQuote,
    supportsMarketOrders: true,
    // A market's fee MODEL is not exchange-authoritative; the flat 0.20% fee
    // described by ndax.io/fees is a model for risk/paper, never a per-trade
    // authoritative fee amount/currency. The authoritative fee asset is derived
    // from `feeProductId` + the product metadata below, never assumed.
    feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
  };
  // Authoritative product metadata (NDAX GetInstruments `product1`/`product2`
  // ids + `product1Symbol`/`product2Symbol`). Absent => fee-currency resolution
  // must fail closed. We NEVER infer base/quote from the symbol string.
  if (r.product1 !== null && r.product1 !== undefined) info.baseProductId = String(r.product1);
  if (r.product2 !== null && r.product2 !== undefined) info.quoteProductId = String(r.product2);
  if (typeof r.product1symbol === 'string' && r.product1symbol !== '') info.baseProductSymbol = String(r.product1symbol);
  if (typeof r.product2symbol === 'string' && r.product2symbol !== '') info.quoteProductSymbol = String(r.product2symbol);
  return info;
}

/** Map a GetAccountPositions row into a Balance. */
export function mapPositionToBalance(raw: Record<string, unknown>): { currency: string; total: Money; hold: Money } {
  const r = lowerKeys(raw);
  const currency = String(r.productsymbol ?? r.currency ?? '');
  return {
    currency,
    total: scaledStrToMoney(r.amount, 8),
    hold: scaledStrToMoney(r.hold, 8),
  };
}

export interface MapOrderOptions {
  /**
   * Resolve an NDAX numeric `Instrument` id to a canonical symbol. REST order
   * objects carry only the numeric instrument id, not the symbol string.
   */
  resolveSymbol?: (instrumentId: string) => string | null;
}

/** Map a GetOpenOrders/GetOrderHistory/GetOrderStatus order object to canonical Order. */
export function mapOrder(raw: Record<string, unknown>, opts: MapOrderOptions = {}): Order {
  const r = lowerKeys(raw);
  const instrumentId = r.instrument != null ? String(r.instrument) : null;
  let symbolCanon = ndaxSymbolToCanonical(r.symbol);
  if (!symbolCanon && instrumentId && opts.resolveSymbol) {
    symbolCanon = opts.resolveSymbol(instrumentId);
  }
  const symbol = symbolCanon ?? `UNKNOWN/${instrumentId ?? ''}`;
  const side = sideOf(r.side);
  const type = orderTypeOf(r.ordertype);
  const state = orderStateOf(r.orderstate);
  const quantity = scaledStrToMoney(r.origquantity ?? r.quantity, 8);
  const filled = scaledStrToMoney(r.quantityexecuted ?? r.filledquantity ?? 0, 8);
  const avg = scaledStrToMoney(r.avgprice ?? r.averageprice ?? 0, 8);
  const price = scaledStrToMoney(r.price ?? 0, 8);
  const rawClientOrderId = r.clientorderid ?? r.origclordid;
  const clientOrderId = rawClientOrderId != null && Number(rawClientOrderId) !== 0 ? String(rawClientOrderId) : '';
  const fillsRaw: unknown[] = Array.isArray(r.fills) ? (r.fills as unknown[]) : [];
  const fills: Fill[] = fillsRaw.map((f) => {
    const fr = lowerKeys(asRecord(f));
    const fpid = fr.feeproductid !== null && fr.feeproductid !== undefined ? String(fr.feeproductid) : null;
    return {
      price: scaledStrToMoney(fr.price, 8),
      quantity: scaledStrToMoney(fr.quantity ?? fr.quantityexecuted, 8),
      fee: scaledStrToMoney(fr.fee ?? 0, 8),
      // AUTHORITATIVE fee currency is ONLY resolved from `feeProductId` against
      // product/instrument metadata. In this pure, context-free mapper we do NOT
      // guess: a non-zero fee with no resolved currency is 'unknown' (downstream
      // MUST fail closed), and `feeProductId` is surfaced verbatim so the caller
      // can resolve it. We NEVER default an NDAX fee to 'quote'.
      feeCurrency: 'unknown',
      ...(fpid !== null ? { feeProductId: fpid } : {}),
      // F-3: fill time is exchange time. If NDAX provides no usable
      // `TradeTimeMs`/`TradeTime`, it is `null` (unknown) — NEVER `Date.now()`.
      timestampMs: exchangeEpochMs(fr.tradetimems ?? fr.tradetime),
    };
  });
  // F-3: order create/update times are exchange receipt/update times. Represent
  // "no authoritative time" as `null`, never a fabricated local `Date.now()`;
  // the update time may fall back to the (already exchange-derived) create time.
  const createdAtMs =
    r.receivetime != null || r.receivetimeticks != null
      ? exchangeEpochMs(r.receivetime ?? r.receivetimeticks)
      : null;
  const updatedAtMs =
    r.lastupdatedtime != null || r.lastupdatedtimeticks != null
      ? exchangeEpochMs(r.lastupdatedtime ?? r.lastupdatedtimeticks)
      : createdAtMs;
  return {
    clientOrderId,
    exchangeOrderId: r.orderid != null ? String(r.orderid) : null,
    symbol,
    side,
    type,
    status: state,
    quantity,
    filledQuantity: filled,
    averagePrice: avg.isZero() ? null : avg,
    price: price.isZero() ? null : price,
    fills,
    fee: scaledStrToMoney(r.fee ?? 0, 8),
    // Order-level NDAX fee currency is NOT determinable from GetOrderStatus
    // fields; we surface the raw amount and leave the currency 'unknown' so the
    // manual/execution layers FAIL CLOSED rather than assume quote.
    feeCurrency: 'unknown',
    reason: String(r.rejectreason ?? r.cancelreason ?? ''),
    createdAtMs,
    updatedAtMs,
  };
}

/**
 * Format an epoch-ms timestamp as NDAX `FromDate`/`ToDate` expects:
 * `"YYYY-MM-DD HH:MM:SS"` in UTC (verified in CCXT: `ymdhms`, space-separated,
 * NOT ISO-8601 with 'T').
 */
export function ymdhms(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** Map an NDAX GetProducts row to a canonical AssetProduct. */
export function mapProduct(raw: Record<string, unknown>): AssetProduct {
  const r = lowerKeys(raw);
  const productTypeNum = Number(r.producttype ?? 0);
  const type: AssetProductType =
    productTypeNum === 1 ? 'nationalCurrency' : productTypeNum === 2 ? 'cryptoCurrency' : productTypeNum === 3 ? 'contract' : 'unknown';
  const tick = r.tickSize != null ? String(r.platformtick ?? r.ticksize ?? r.tickSize) : null;
  return {
    productId: String(r.productid ?? r.product ?? ''),
    symbol: String(r.product ?? ''),
    name: String(r.productfullname ?? r.product ?? ''),
    type,
    decimalPlaces: typeof r.decimalplaces === 'number' ? r.decimalplaces : Number(r.decimalplaces ?? 0),
    tickSize: tick || null,
    noFees: r.nofees === true || r.nofees === 1,
  };
}

/** Convert a canonical Timeframe to NDAX interval seconds. */
export function timeframeToInterval(tf: Timeframe): number {
  const seconds: Record<Timeframe, number> = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400,
  };
  return seconds[tf];
}

/** Convert NDAX interval seconds back to a canonical Timeframe, or null. */
export function intervalToTimeframe(seconds: number): Timeframe | null {
  const map: Record<number, Timeframe> = {
    60: '1m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 14400: '4h', 86400: '1d',
  };
  return map[seconds] ?? null;
}
