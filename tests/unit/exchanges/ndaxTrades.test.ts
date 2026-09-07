/**
 * Gate 9.2 — NDAX authoritative account-trade mapping (GetAccountTrades).
 *
 * The account-trade read is the only NDAX surface that carries execution/trade ids
 * and `feeProductId`. These tests pin the FAIL-CLOSED mapping semantics:
 * ids and the fee product are preserved VERBATIM or null, never fabricated, never
 * coerced to a currency, and a symbol is never guessed.
 */

import { describe, expect, it } from 'vitest';
import { mapAccountTrade, mapAccountTrades } from '../../../src/exchanges/ndax/tradeMappings.js';

const DOCUMENTED_ROW: Record<string, unknown> = {
  ExecutionId: 123456789,
  TradeId: 987654321,
  OrderId: 100001,
  AccountId: 449,
  SubAccountId: 0,
  ClientOrderId: 0,
  InstrumentId: 3,
  Side: 0,
  Quantity: 0.5,
  RemainingQuantity: 0,
  Price: 88000.5,
  Value: 44000.25,
  TradeTimeMS: 1700000000000,
  Fee: 10.5,
  FeeProductId: 2,
  OrderOriginator: 'api',
};

describe('Gate 9.2 — mapAccountTrade (authoritative, fail-closed)', () => {
  it('populates executionId/tradeId/orderId/accountId/instrumentId/feeProductId verbatim', () => {
    const t = mapAccountTrade(DOCUMENTED_ROW, { resolveSymbol: () => 'BTC/CAD' });
    expect(t.executionId).toBe('123456789');
    expect(t.tradeId).toBe('987654321');
    expect(t.orderId).toBe('100001');
    expect(t.accountId).toBe('449');
    expect(t.subAccountId).toBe('0');
    expect(t.instrumentId).toBe('3');
    expect(t.symbol).toBe('BTC/CAD');
    expect(t.side).toBe('BUY');
    expect(t.quantity.toFixed(8)).toBe('0.50000000');
    expect(t.remainingQuantity.isZero()).toBe(true);
    expect(t.price.toFixed(2)).toBe('88000.50');
    expect(t.value.toFixed(2)).toBe('44000.25');
    expect(t.tradeTimeMs).toBe(1700000000000);
    expect(t.fee.toFixed(2)).toBe('10.50');
    // feeProductId is a raw product id — NEVER coerced to a currency.
    expect(t.feeProductId).toBe('2');
    expect(t.orderOriginator).toBe('api');
  });

  it('a SELL side and a string side both map correctly', () => {
    expect(mapAccountTrade({ ...DOCUMENTED_ROW, Side: 1 }, {}).side).toBe('SELL');
    expect(mapAccountTrade({ ...DOCUMENTED_ROW, Side: 'Sell', InstrumentId: 3 }, { resolveSymbol: () => 'BTC/CAD' }).side).toBe('SELL');
  });

  it('missing executionId is null (never fabricated); a reported id is preserved verbatim', () => {
    const missing = mapAccountTrade({ ...DOCUMENTED_ROW, ExecutionId: undefined }, {});
    expect(missing.executionId).toBeNull();
    // A reported 0 is preserved verbatim (not fabricated, not coerced to null).
    const zero = mapAccountTrade({ ...DOCUMENTED_ROW, ExecutionId: 0 }, {});
    expect(zero.executionId).toBe('0');
    expect(zero.tradeId).toBe('987654321');
  });

  it('missing feeProductId is null (never defaulted to quote)', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, FeeProductId: undefined }, {});
    expect(t.feeProductId).toBeNull();
  });

  it('feeProductId is preserved even when it is neither base nor quote (no conversion)', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, FeeProductId: 999 }, {});
    expect(t.feeProductId).toBe('999');
  });

  it('missing/invalid trade time is null (never a local Date.now())', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, TradeTimeMS: 0 }, {});
    expect(t.tradeTimeMs).toBeNull();
  });

  it('an unresolvable instrument id yields a null symbol (never guessed)', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, InstrumentId: 999 }, { resolveSymbol: () => null });
    expect(t.symbol).toBeNull();
    expect(t.instrumentId).toBe('999');
  });

  it('two executions sharing one OrderId remain distinct and are both preserved', () => {
    const rows = [
      { ...DOCUMENTED_ROW, ExecutionId: 1, TradeId: 100, OrderId: 42, Quantity: 0.3, RemainingQuantity: 0.2 },
      { ...DOCUMENTED_ROW, ExecutionId: 2, TradeId: 101, OrderId: 42, Quantity: 0.2, RemainingQuantity: 0 },
    ];
    const trades = mapAccountTrades(rows);
    expect(trades.length).toBe(2);
    expect(trades[0]!.executionId).toBe('1');
    expect(trades[1]!.executionId).toBe('2');
    expect(trades[0]!.orderId).toBe('42');
    expect(trades[1]!.orderId).toBe('42');
  });

  it('a partial fill exposes a non-zero remainingQuantity without implying full execution', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, Quantity: 0.3, RemainingQuantity: 0.2 }, {});
    expect(t.quantity.toFixed(8)).toBe('0.30000000');
    expect(t.remainingQuantity.toFixed(8)).toBe('0.20000000');
  });

  it('identity separation: executionId, orderId, tradeId are distinct fields, never conflated', () => {
    const t = mapAccountTrade(DOCUMENTED_ROW, { resolveSymbol: () => 'BTC/CAD' });
    expect(t.executionId).not.toBe(t.orderId);
    expect(t.executionId).not.toBe(t.tradeId);
    expect(t.tradeId).not.toBe(t.orderId);
  });

  it('missing orderId is null (never fabricated)', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, OrderId: undefined }, {});
    expect(t.orderId).toBeNull();
  });

  it('a missing executionId with an otherwise valid row still reports the orderId/feeProductId (partial evidence)', () => {
    const t = mapAccountTrade({ ...DOCUMENTED_ROW, ExecutionId: undefined }, {});
    expect(t.executionId).toBeNull();
    expect(t.orderId).toBe('100001');
    expect(t.feeProductId).toBe('2');
  });

  it('malformed rows are dropped (fail closed, never coerced into an inventory)', () => {
    const valid = mapAccountTrade(DOCUMENTED_ROW, { resolveSymbol: () => 'BTC/CAD' });
    const out = mapAccountTrades([DOCUMENTED_ROW, 'garbage', null, 42]);
    expect(out.length).toBe(1);
    expect(out[0]!.executionId).toBe(valid.executionId);
  });
});
