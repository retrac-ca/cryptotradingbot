/**
 * Signal types.
 *
 * A strategy NEVER places an order. It inspects a read-only `StrategyContext`
 * and returns a `Signal`. A downstream layer (risk → execution) decides whether
 * and how to act on it. The canonical `Signal` type lives in `src/order.ts`;
 * this module re-exports it and provides typed helpers for constructing signals
 * so strategies read cleanly.
 */

import type { Signal as CanonicalSignal, OrderSide } from '../order.js';
import type { Money } from '../money/Money.js';

export type { Signal } from '../order.js';
export type SignalType = 'BUY' | 'SELL' | 'HOLD';

/** Map a signal type to the order side that would act on it, if any. */
export function signalToOrderSide(type: SignalType): OrderSide | null {
  if (type === 'BUY') return 'BUY';
  if (type === 'SELL') return 'SELL';
  return null;
}

export interface SignalOptions {
  /** Optional self-reported confidence in [0,1]. */
  confidence?: number;
  /** Optional human-readable rationale for auditability. */
  reason?: string;
  /**
   * Optional entry anchor price (quote per base unit) carried onto the resulting
   * position when a BUY is filled while flat. Strategy-agnostic opaque data.
   */
  entryAnchorPrice?: Money;
}

/** Build a canonical signal for a symbol at the current logical time. */
export function signal(
  symbol: string,
  type: SignalType,
  options: SignalOptions = {},
  nowMs: number = Date.now(),
): CanonicalSignal {
  return {
    symbol,
    type,
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.entryAnchorPrice !== undefined ? { entryAnchorPrice: options.entryAnchorPrice } : {}),
    timestampMs: nowMs,
  };
}

/** Convenience: a HOLD signal (the common no-op case). */
export function hold(symbol: string, reason?: string, nowMs?: number): CanonicalSignal {
  return signal(symbol, 'HOLD', { reason }, nowMs);
}
