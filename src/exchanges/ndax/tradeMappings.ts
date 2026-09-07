/**
 * Pure mapping for authenticated account trade/fill reads (NDAX
 * `GetAccountTrades` / `GetTradesHistory`).
 *
 * This surfaces authoritative exchange data that the order-level `mapOrder`
 * deliberately does NOT expose:
 *   - `executionId`, `tradeId` (execution/trade identity candidates),
 *   - `feeProductId` (the asset in which the fee was charged),
 *   - `orderId`, `clientOrderId`, `accountId`, `subAccountId`, `orderOriginator`,
 *   - `instrumentId`, `remainingQuantity`, `value`.
 *
 * Critical fail-closed rules (Gate 9.2):
 *   - We NEVER coerce `feeProductId` into 'base'/'quote'. The fee currency is
 *     only meaningful once `feeProductId` is resolved to an asset via `GetProducts`
 *     and compared to the instrument's product1/product2 — which the adapter does
 *     NOT currently surface, so the projection is left to the caller and defaults
 *     to UNKNOWN (null below). This removes the unsafe `mapOrder` assumption.
 *   - `executionId`/`tradeId` are reported VERBATIM or `null`; we do NOT infer
 *     uniqueness from the field name, and we do NOT fabricate an id when absent.
 *   - `symbol` is resolved from the instrument id only; if unresolvable it is
 *     `null` (never "guessed").
 *   - Missing/invalid timestamps map to `null` (never a local `Date.now()`).
 */

import type { AccountTrade } from '../../types.js';
import type { OrderSide } from '../../order.js';
import { exchangeEpochMs, ndaxSymbolToCanonical, scaledStrToMoney } from './mappings.js';

export interface MapAccountTradeOptions {
  /** Resolve an NDAX numeric instrument id to a canonical symbol. */
  resolveSymbol?: (instrumentId: string) => string | null;
}

function lowerKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function sideOf(v: unknown): OrderSide {
  if (typeof v === 'number') return v === 1 ? 'SELL' : 'BUY';
  if (typeof v === 'string') {
    if (v.trim().toLowerCase() === 'sell') return 'SELL';
    if (/^\d+$/.test(v.trim())) return Number(v.trim()) === 1 ? 'SELL' : 'BUY';
    return v.trim().toLowerCase() === 'buy' ? 'BUY' : 'SELL';
  }
  return 'SELL';
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  // Preserve VERBATIM (including a numeric 0, which is meaningful e.g. for a
  // main sub-account and for an otherwise-"unset" client order id). We never
  // fabricate a value, and we never coerce an id into a currency.
  return s;
}

/**
 * Map one NDAX GetAccountTrades row into a canonical `AccountTrade`.
 *
 * Preserves the authoritative ids verbatim; never coerces feeProductId to a
 * currency; never fabricates an id/timestamp/symbol.
 */
export function mapAccountTrade(raw: Record<string, unknown>, opts: MapAccountTradeOptions = {}): AccountTrade {
  const r = lowerKeys(raw);

  const instrumentId = asStringOrNull(r.instrument ?? r.instrumentid);
  let symbol = ndaxSymbolToCanonical(r.symbol);
  if (!symbol && instrumentId && opts.resolveSymbol) symbol = opts.resolveSymbol(instrumentId);
  const price = scaledStrToMoney(r.price, 8);
  const quantity = scaledStrToMoney(r.quantity ?? r.quantityexecuted, 8);

  return {
    executionId: asStringOrNull(r.executionid),
    tradeId: asStringOrNull(r.tradeid),
    orderId: asStringOrNull(r.orderid),
    clientOrderId: asStringOrNull(r.clientorderid),
    symbol: symbol ?? null,
    instrumentId,
    accountId: asStringOrNull(r.accountid),
    subAccountId: asStringOrNull(r.subaccountid),
    side: sideOf(r.side),
    quantity,
    remainingQuantity: scaledStrToMoney(r.remainingquantity, 8),
    price,
    value: scaledStrToMoney(r.value, 8),
    // NDAX exposes both `tradeTime` and `tradeTimeMS`; prefer MS when usable.
    tradeTimeMs: exchangeEpochMs(r.tradetimems ?? r.tradetime),
    fee: scaledStrToMoney(r.fee ?? 0, 8),
    feeProductId: asStringOrNull(r.feeproductid),
    orderOriginator: asStringOrNull(r.orderoriginator),
  };
}

/** Map an array of NDAX GetAccountTrades rows, dropping nothing and failing closed. */
export function mapAccountTrades(rows: unknown[], opts: MapAccountTradeOptions = {}): AccountTrade[] {
  const out: AccountTrade[] = [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      out.push(mapAccountTrade(row as Record<string, unknown>, opts));
    }
  }
  return out;
}
