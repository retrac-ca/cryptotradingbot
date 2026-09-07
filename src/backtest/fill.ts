/**
 * Deterministic fill simulation (Backtesting V1).
 *
 * A pending order fills COMPLETELY at the next available bar's OPEN price,
 * adjusted by a per-side slippage, then normalized to the exchange price tick:
 *  - BUY  rounds UP  (pay at least the tick)
 *  - SELL rounds DOWN (receive at most the tick)
 *
 * V1 has NO partial fills: an order either fills completely or is rejected.
 * All arithmetic is exact fixed-point `Money` (BigInt) — no floating-point money.
 *
 * These helpers are pure and deterministic; the engine enforces the remaining
 * execution-time safety checks (affordability, min quantity, position).
 */

import { Money } from '../money/Money.js';
import type { OrderSide } from '../order.js';

/** Slippage is resolved to an exact fraction (resolved to 9 decimals). */
const SLIP_SCALE: bigint = 1_000_000_000n;

/** Exact slippage factor: BUY = 1+slip, SELL = 1-slip (as numerator over SLIP_SCALE). */
function slippageFactor(slippageFraction: number, side: OrderSide): bigint {
  const slip = BigInt(Math.round(slippageFraction * Number(SLIP_SCALE)));
  return side === 'BUY' ? SLIP_SCALE + slip : SLIP_SCALE - slip;
}

/** Round UP (toward +infinity on the value) to a multiple of `increment`. */
function ceilToIncrement(value: Money, increment: Money): Money {
  if (increment.scaled <= 0n) {
    throw new Error('ceilToIncrement: increment must be positive');
  }
  const negative = value.scaled < 0n;
  const abs = negative ? -value.scaled : value.scaled;
  const inc = increment.scaled;
  const quotient = abs / inc;
  const remainder = abs % inc;
  const ceil = remainder === 0n ? quotient : quotient + 1n;
  return Money.fromScaled((negative ? -ceil : ceil) * inc);
}

/**
 * Compute the deterministic fill price for a side at a bar's OPEN price.
 *
 * `raw = open * (1 ± slippage)`, then:
 *   - BUY  -> round UP to `priceTick`;
 *   - SELL -> round DOWN to `priceTick`.
 */
export function computeFillPrice(open: Money, side: OrderSide, slippageFraction: number, priceTick: Money): Money {
  const factor = slippageFactor(slippageFraction, side);
  const raw = open.mulFraction(factor, SLIP_SCALE);
  if (side === 'BUY') return ceilToIncrement(raw, priceTick);
  return raw.floorToIncrement(priceTick);
}
