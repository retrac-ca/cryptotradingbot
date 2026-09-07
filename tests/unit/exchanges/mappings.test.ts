import { describe, expect, it } from 'vitest';
import {
  ndaxSymbolToCanonical,
  canonicalToNdaxSymbol,
  scaledStrToMoney,
  mapLevel1ToTicker,
  mapL2ToOrderBook,
  mapTickerHistoryRow,
  mapInstrumentToMarketInfo,
  mapPositionToBalance,
  mapOrder,
  timeframeToInterval,
  intervalToTimeframe,
  ymdhms,
} from '../../../src/exchanges/ndax/mappings.js';

describe('NDAX mappings', () => {
  describe('scaledStrToMoney', () => {
    it('parses decimal prices exactly (no float error)', () => {
      const m = scaledStrToMoney('88123.45', 8);
      expect(m.toFixed(2)).toBe('88123.45');
    });

    it('handles numbers and strings', () => {
      expect(scaledStrToMoney(8800.5, 8).toFixed(2)).toBe('8800.50');
      expect(scaledStrToMoney('0', 8).isZero()).toBe(true);
    });

    it('treats null/empty as zero', () => {
      expect(scaledStrToMoney(null, 8).isZero()).toBe(true);
      expect(scaledStrToMoney(undefined, 8).isZero()).toBe(true);
      expect(scaledStrToMoney('', 8).isZero()).toBe(true);
    });
  });

  describe('symbol conversion', () => {
    it('converts NDAX concatenated symbol to canonical base/quote', () => {
      expect(ndaxSymbolToCanonical('BTCCAD')).toBe('BTC/CAD');
      expect(ndaxSymbolToCanonical('ETHUSD')).toBe('ETH/USD');
      expect(ndaxSymbolToCanonical('ADAUSDT')).toBe('ADA/USDT');
    });

    it('round-trips canonical -> NDAX', () => {
      expect(canonicalToNdaxSymbol('BTC/CAD')).toBe('BTCCAD');
    });

    it('returns null for unknown/resolvable symbols', () => {
      expect(ndaxSymbolToCanonical('XYZ')).toBeNull();
    });
  });

  describe('mapLevel1ToTicker', () => {
    it('maps full-precision fields into a Ticker', () => {
      const raw = {
        bestBid: 88100.5,
        bestOffer: 88101.25,
        lastTradedPx: 88100.75,
        sessionOpen: 87900,
        sessionHigh: 88200,
        sessionLow: 87700,
        rolling24HrVolume: 1234.567,
        lastTradeTime: 1700000000000,
      };
      const ticker = mapLevel1ToTicker('BTC/CAD', raw as never);
      expect(ticker.symbol).toBe('BTC/CAD');
      expect(ticker.bid!.toFixed(2)).toBe('88100.50');
      expect(ticker.ask!.toFixed(2)).toBe('88101.25');
      expect(ticker.last!.toFixed(2)).toBe('88100.75');
      expect(ticker.timestampMs).toBe(1700000000000);
    });

    it('prefers `timestamp` over `lastTradeTime`', () => {
      const raw = { timestamp: 1700000001000, lastTradeTime: 1700000000000 };
      expect(mapLevel1ToTicker('BTC/CAD', raw as never).timestampMs).toBe(1700000001000);
    });

    it('F-3: a missing exchange timestamp becomes null (never local Date.now())', () => {
      const raw = { bestBid: 1, bestOffer: 2, lastTradedPx: 1.5 };
      const ticker = mapLevel1ToTicker('BTC/CAD', raw as never);
      expect(ticker.timestampMs).toBeNull();
    });

    it('F-3: a zero timestamp fails closed and becomes null', () => {
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: 0 } as never).timestampMs).toBeNull();
    });

    it('F-3: a negative timestamp fails closed and becomes null', () => {
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: -5 } as never).timestampMs).toBeNull();
    });

    it('F-3: a NaN / non-numeric timestamp fails closed and becomes null', () => {
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: NaN } as never).timestampMs).toBeNull();
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: 'not-a-date' } as never).timestampMs).toBeNull();
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: undefined } as never).timestampMs).toBeNull();
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: '' } as never).timestampMs).toBeNull();
    });

    it('F-3: a numeric string epoch is still accepted', () => {
      expect(mapLevel1ToTicker('BTC/CAD', { timestamp: '1700000000000' } as never).timestampMs).toBe(1700000000000);
    });
  });

  describe('mapL2ToOrderBook', () => {
    it('splits and sorts bids/asks', () => {
      // [MDUpdateId, AccountId, ActionDateTime, ActionType, LastTradePrice,
      //  OrderId, Price, ProductPairCode, Quantity, Side]
      const rows = [
        [1, 0, 1, 0, 0, 1, 88100.5, 1, 0.5, 0], // buy
        [2, 0, 1, 0, 0, 2, 88100.75, 1, 0.4, 0], // buy (higher)
        [3, 0, 1, 0, 0, 3, 88101.5, 1, 0.6, 1], // sell
        [4, 0, 1, 0, 0, 4, 88101.25, 1, 0.7, 1], // sell (lower)
      ];
      const book = mapL2ToOrderBook('BTC/CAD', rows as never);
      expect(book.bids.length).toBe(2);
      expect(book.asks.length).toBe(2);
      // bids best-first (descending)
      expect(book.bids[0]!.price.toFixed(2)).toBe('88100.75');
      expect(book.bids[1]!.price.toFixed(2)).toBe('88100.50');
      // asks best-first (ascending)
      expect(book.asks[0]!.price.toFixed(2)).toBe('88101.25');
      expect(book.asks[1]!.price.toFixed(2)).toBe('88101.50');
    });

    it('sets quoteTimestampMs and timestampMs to the newest valid ActionDateTime', () => {
      const rows = [
        [1, 0, 1700000000000, 0, 0, 1, 88100.5, 1, 0.5, 0],
        [2, 0, 1700000001000, 0, 0, 2, 88100.75, 1, 0.4, 0],
        [3, 0, 1700000002000, 0, 0, 3, 88101.5, 1, 0.6, 1],
        [4, 0, -1, 0, 0, 4, 88101.25, 1, 0.7, 1], // invalid -> ignored
      ];
      const book = mapL2ToOrderBook('BTC/CAD', rows as never);
      // The newest positive ActionDateTime is row [3] (1700000002000).
      expect(book.quoteTimestampMs).toBe(1700000002000);
      // F-3: timestampMs is the exchange quote time (never a local Date.now()).
      expect(book.timestampMs).toBe(1700000002000);
    });

    it('omits quoteTimestampMs when no valid ActionDateTime exists (timestampMs null)', () => {
      const rows = [
        [1, 0, -5, 0, 0, 1, 88100.5, 1, 0.5, 0],
        [2, 0, 0, 0, 0, 3, 88101.5, 1, 0.6, 1],
      ];
      const book = mapL2ToOrderBook('BTC/CAD', rows as never);
      expect(book.quoteTimestampMs).toBeUndefined();
      expect(book.timestampMs).toBeNull();
    });
  });

  describe('mapTickerHistoryRow', () => {
    it('maps a candle row to a Candle', () => {
      const row = [1700000000000, 88100, 87900, 87950, 88050, 12.5, 88000, 88050, 1];
      const c = mapTickerHistoryRow('BTC/CAD', '5m', row as never);
      expect(c.timeframe).toBe('5m');
      expect(c.timestampMs).toBe(1700000000000);
      expect(c.open.toFixed(2)).toBe('87950.00');
      expect(c.close.toFixed(2)).toBe('88050.00');
      expect(c.high.toFixed(2)).toBe('88100.00');
      expect(c.low.toFixed(2)).toBe('87900.00');
      expect(c.baseVolume.toFixed(2)).toBe('12.50');
    });
  });

  describe('mapInstrumentToMarketInfo', () => {
    it('resolves symbol, ids, ticks and defaults', () => {
      const m = mapInstrumentToMarketInfo({
        symbol: 'BTCCAD',
        instrumentId: 1,
        priceIncrement: 0.01,
        quantityIncrement: 0.00000001,
      });
      expect(m.symbol).toBe('BTC/CAD');
      expect(m.exchangeId).toBe('1');
      expect(m.priceTick.toFixed(2)).toBe('0.01');
      expect(m.quantityTick.toFixed(8)).toBe('0.00000001');
      expect(m.supportsMarketOrders).toBe(true);
      expect(m.feeInfo).toEqual({ maker: 0.002, taker: 0.002, feeCurrency: 'quote' });
    });

    it('maps minimum quantity when present', () => {
      const m = mapInstrumentToMarketInfo({
        symbol: 'BTCUSDT', instrumentId: 3, priceIncrement: 0.01, quantityIncrement: 0.00000001,
        minimumQuantity: 0.0001, minimumPrice: 1,
      });
      expect(m.minOrderBase!.toFixed(4)).toBe('0.0001');
      // 'MinimumPrice' is a price FLOOR (e.g. 25000 for BTCCAD), not a minimum
      // order notional — it must NOT be mapped to minOrderQuote (live-verified).
      expect(m.minOrderQuote).toBeNull();
    });

    it('handles long decimal-string increments from GetInstruments', () => {
      const m = mapInstrumentToMarketInfo({
        Symbol: 'BTCCAD', InstrumentId: 1,
        QuantityIncrement: '0.0000000100000000000000000000',
        PriceIncrement: '0.0000000100000000000000000000',
        MinimumQuantity: '0.0100000000000000000000000000',
      });
      expect(m.quantityTick.toFixed(8)).toBe('0.00000001');
      expect(m.minOrderBase!.toFixed(2)).toBe('0.01');
    });

    it('throws on unresolvable symbol', () => {
      expect(() => mapInstrumentToMarketInfo({ symbol: 'XYZ', instrumentId: 1 } as never)).toThrow();
    });
  });

  describe('mapPositionToBalance', () => {
    it('parses amount and hold', () => {
      const b = mapPositionToBalance({ productSymbol: 'BTC', amount: 0.5, hold: 0.1 });
      expect(b.currency).toBe('BTC');
      expect(b.total.toFixed(2)).toBe('0.50');
      expect(b.hold.toFixed(2)).toBe('0.10');
    });
  });

  describe('mapOrder', () => {
    it('maps a working buy limit order', () => {
      const o = mapOrder({
        side: 0, orderType: 2, orderState: 1, orderId: 55, clientOrderId: 'abc',
        symbol: 'BTCCAD', quantity: 0.5, quantityExecuted: 0.2, price: 88000, avgPrice: 87990,
      });
      expect(o.symbol).toBe('BTC/CAD');
      expect(o.side).toBe('BUY');
      expect(o.type).toBe('limit');
      expect(o.status).toBe('OPEN');
      expect(o.exchangeOrderId).toBe('55');
      expect(o.quantity.toFixed(2)).toBe('0.50');
      expect(o.filledQuantity.toFixed(2)).toBe('0.20');
    });

    it('maps order states', () => {
      expect(mapOrder({ side: 1, orderType: 1, orderState: 5, orderId: 1, symbol: 'BTCCAD', quantity: 1 }).status).toBe('FILLED');
      expect(mapOrder({ side: 0, orderType: 1, orderState: 2, orderId: 1, symbol: 'BTCCAD', quantity: 1 }).status).toBe('REJECTED');
      expect(mapOrder({ side: 0, orderType: 1, orderState: 3, orderId: 1, symbol: 'BTCCAD', quantity: 1 }).status).toBe('CANCELED');
    });

    it('maps string wire fields (OrderState/Side/OrderType) like the production REST API', () => {
      const o = mapOrder({
        OrderId: 55,
        Side: 'Buy',
        OrderType: 'Limit',
        OrderState: 'Working',
        OrigQuantity: 0.5,
        QuantityExecuted: 0,
        Price: 88000,
        AvgPrice: 0,
        Instrument: 1,
      }, { resolveSymbol: () => 'BTC/CAD' });
      expect(o.symbol).toBe('BTC/CAD');
      expect(o.side).toBe('BUY');
      expect(o.type).toBe('limit');
      expect(o.status).toBe('OPEN');
      expect(o.exchangeOrderId).toBe('55');
      expect(o.quantity.toFixed(2)).toBe('0.50');
    });

    it('maps FullyExecuted and Canceled string states', () => {
      expect(mapOrder({ OrderId: 1, OrderState: 'FullyExecuted', Symbol: 'BTCCAD' }).status).toBe('FILLED');
      expect(mapOrder({ OrderId: 1, OrderState: 'Canceled', Symbol: 'BTCCAD' }).status).toBe('CANCELED');
      expect(mapOrder({ OrderId: 1, OrderState: 'Rejected', Symbol: 'BTCCAD' }).status).toBe('REJECTED');
    });

    it('maps a string but unknown state to UNKNOWN (not crash)', () => {
      expect(mapOrder({ OrderId: 1, OrderState: 'Cancelled-odd', Symbol: 'BTCCAD' }).status).toBe('UNKNOWN');
    });

    it('F-3: maps exchange fill/order timestamps when present', () => {
      const o = mapOrder({
        OrderId: 55, OrderState: 'FullyExecuted', Symbol: 'BTCCAD', Quantity: 1,
        ReceiveTime: 1700000000000, LastUpdatedTime: 1700000001000,
        Fills: [{ Price: 88000, Quantity: 1, TradeTimeMs: 1700000000500 }],
      });
      expect(o.createdAtMs).toBe(1700000000000);
      expect(o.updatedAtMs).toBe(1700000001000);
      expect(o.fills[0]!.timestampMs).toBe(1700000000500);
    });

    it('F-3: a missing exchange order/fill timestamp is null (never Date.now())', () => {
      // No ReceiveTime / TradeTime / LastUpdatedTime -> unknown, NOT fabricated.
      const o = mapOrder({ OrderId: 7, OrderState: 'FullyExecuted', Symbol: 'BTCCAD', Quantity: 1, Fills: [{ Price: 1, Quantity: 1 }] });
      expect(o.createdAtMs).toBeNull();
      expect(o.updatedAtMs).toBeNull();
      expect(o.fills[0]!.timestampMs).toBeNull();
    });

    it('F-3: zero/negative exchange timestamps fail closed to null', () => {
      const byTs = mapOrder({ OrderId: 1, OrderState: 'Canceled', Symbol: 'BTCCAD', ReceiveTime: 0 });
      const negTs = mapOrder({ OrderId: 1, OrderState: 'Canceled', Symbol: 'BTCCAD', ReceiveTime: -5 });
      expect(byTs.createdAtMs).toBeNull();
      expect(negTs.createdAtMs).toBeNull();
    });
  });

  describe('mapInstrumentToMarketInfo (capitalized keys)', () => {
    it('reads MinimumQuantity/MinimumPrice case-insensitively', () => {
      const m = mapInstrumentToMarketInfo({
        Symbol: 'BTCCAD',
        InstrumentId: 1,
        PriceIncrement: 0.01,
        QuantityIncrement: 0.00000001,
        MinimumQuantity: 0.0001,
        MinimumPrice: 1,
      });
      expect(m.symbol).toBe('BTC/CAD');
      expect(m.exchangeId).toBe('1');
      expect(m.minOrderBase!.toFixed(4)).toBe('0.0001');
      // MinimumPrice is a price floor, not a minimum order notional.
      expect(m.minOrderQuote).toBeNull();
    });
  });

  describe('ymdhms', () => {
    it('formats epoch ms as "YYYY-MM-DD HH:MM:SS" (UTC, space separator)', () => {
      const s = ymdhms(Date.UTC(2026, 7, 28, 12, 5, 9));
      expect(s).toBe('2026-08-28 12:05:09');
      expect(s).not.toContain('T');
    });

    it('zero-pads month/day/hour/min/sec', () => {
      expect(ymdhms(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
    });
  });

  describe('timeframe conversion', () => {
    it('round-trips timeframes', () => {
      expect(timeframeToInterval('5m')).toBe(300);
      expect(timeframeToInterval('1d')).toBe(86400);
      expect(intervalToTimeframe(3600)).toBe('1h');
      expect(intervalToTimeframe(60)).toBe('1m');
      expect(intervalToTimeframe(12345)).toBeNull();
    });
  });
});
