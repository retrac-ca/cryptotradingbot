import { describe, expect, it } from 'vitest';
import {
  toNdaxOrderType,
  toNdaxTimeInForce,
  toNdaxClientOrderId,
  toNdaxSendOrderRequest,
  toNdaxCancelOrderRequest,
  mapSendOrderResponse,
  mapCancelOrderResponse,
} from '../../../src/exchanges/ndax/orderMappings.js';
import { OrderRejectedError, InvalidResponseError } from '../../../src/exchanges/errors.js';
import { Money } from '../../../src/money/Money.js';
import type { NewOrder } from '../../../src/order.js';
import type { MarketInfo } from '../../../src/types.js';

const MARKET: MarketInfo = {
  symbol: 'BTC/CAD',
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 8,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: null,
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

const limitBuy: NewOrder = {
  symbol: 'BTC/CAD',
  side: 'BUY',
  type: 'limit',
  quantity: Money.fromString('0.5'),
  price: Money.fromString('88000.00'),
  tif: 'GTC',
  clientOrderId: 'local-abc-123',
  reason: 'backtest entry',
};

const marketSell: NewOrder = {
  symbol: 'BTC/CAD',
  side: 'SELL',
  type: 'market',
  quantity: Money.fromString('0.25'),
  clientOrderId: 'local-def-456',
  reason: 'take profit',
};

describe('NDAX order mappings', () => {
  describe('enum mapping', () => {
    it('maps canonical order type to NDAX integers', () => {
      expect(toNdaxOrderType('market')).toBe(1);
      expect(toNdaxOrderType('limit')).toBe(2);
    });

    it('maps TimeInForce to NDAX integers, defaulting to GTC (1)', () => {
      expect(toNdaxTimeInForce('GTC')).toBe(1);
      expect(toNdaxTimeInForce('IOC')).toBe(3);
      expect(toNdaxTimeInForce('FOK')).toBe(4);
      expect(toNdaxTimeInForce(undefined)).toBe(1);
    });

    it('does not forward a non-numeric client order id by default; forwards numeric', () => {
      expect(toNdaxClientOrderId('local-abc-123')).toBe(0);
      expect(toNdaxClientOrderId('12345', true)).toBe(12345);
      expect(() => toNdaxClientOrderId('local-abc-123', true)).toThrow(/integer/);
    });
  });

  describe('toNdaxSendOrderRequest', () => {
    it('builds a limit BUY request matching the documented shape', () => {
      const body = toNdaxSendOrderRequest(limitBuy, MARKET, 449);
      expect(body).toEqual({
        InstrumentId: 1,
        OMSId: 1,
        AccountId: 449,
        TimeInForce: 1,
        ClientOrderId: 0,
        OrderIdOCO: 0,
        UseDisplayQuantity: false,
        Side: 0,
        quantity: 0.5,
        OrderType: 2,
        PegPriceType: 1,
        LimitPrice: 88000,
      });
    });

    it('builds a market SELL request without a LimitPrice', () => {
      const body = toNdaxSendOrderRequest(marketSell, MARKET, 449);
      expect(body.Side).toBe(1);
      expect(body.OrderType).toBe(1);
      expect('LimitPrice' in body).toBe(false);
      expect(body.quantity).toBe(0.25);
    });

    it('throws if the market has no resolvable instrument id', () => {
      const bad: MarketInfo = { ...MARKET, exchangeId: '' };
      expect(() => toNdaxSendOrderRequest(limitBuy, bad, 449)).toThrow(/instrument id/);
    });

    it('throws if a limit order has no price', () => {
      const noPrice: NewOrder = { ...limitBuy, price: undefined };
      expect(() => toNdaxSendOrderRequest(noPrice, MARKET, 449)).toThrow(/requires a price/);
    });
  });

  describe('toNdaxCancelOrderRequest', () => {
    it('builds the documented CancelOrder body and rejects non-numeric ids', () => {
      expect(toNdaxCancelOrderRequest('55', 449)).toEqual({ OMSId: 1, AccountId: 449, OrderId: 55 });
      expect(() => toNdaxCancelOrderRequest('not-numeric', 449)).toThrow(/OrderId/);
    });
  });

  describe('mapSendOrderResponse', () => {
    it('maps an Accepted response to an acknowledged result with the server OrderId', () => {
      const res = mapSendOrderResponse({ status: 'Accepted', errormsg: '', OrderId: 123 });
      expect(res.exchangeOrderId).toBe('123');
      expect(res.unknownOutcome).toBe(false);
    });

    it('throws OrderRejectedError on a Rejected response', () => {
      expect(() => mapSendOrderResponse({ status: 'Rejected', errormsg: 'Not_Enough_Funds', OrderId: 0 }))
        .toThrow(OrderRejectedError);
    });

    it('throws InvalidResponseError on a non-object response', () => {
      expect(() => mapSendOrderResponse([])).toThrow(InvalidResponseError);
      expect(() => mapSendOrderResponse(null)).toThrow(InvalidResponseError);
    });

    it('fails closed as AMBIGUOUS when the ack status is missing or unrecognized', () => {
      // A generic {result:true} wrapper is not the documented SendOrder shape:
      // we cannot know whether the order was accepted => reconcile, don't claim ack.
      expect(() => mapSendOrderResponse({ result: true })).toThrow(InvalidResponseError);
      expect(() => mapSendOrderResponse({ status: 'Maybe', OrderId: 5 })).toThrow(InvalidResponseError);
      expect(() => mapSendOrderResponse({})).toThrow(InvalidResponseError);
    });

    it('maps an Accepted response without OrderId to acknowledged with null exchange id', () => {
      const res = mapSendOrderResponse({ status: 'Accepted', errormsg: '' });
      expect(res.exchangeOrderId).toBe(null);
      expect(res.unknownOutcome).toBe(false);
    });
  });

  describe('mapCancelOrderResponse', () => {
    it('reflects receipt acknowledgement with unknown order status', () => {
      const res = mapCancelOrderResponse({ result: true, errormsg: '', errorcode: 0, detail: '' });
      expect(res.acknowledged).toBe(true);
      expect(res.orderStatus).toBe(null);
    });

    it('reports not acknowledged when result is false', () => {
      expect(mapCancelOrderResponse({ result: false, errormsg: 'Operation Failed' }).acknowledged).toBe(false);
    });

    it('throws InvalidResponseError on a non-object response', () => {
      expect(() => mapCancelOrderResponse('oops')).toThrow(InvalidResponseError);
    });
  });
});
