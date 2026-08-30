/**
 * Safe money/quantity representation using fixed-point scaled integers.
 *
 * JavaScript `number` is IEEE-754 binary64 (double). It cannot represent most
 * decimal fractions exactly (e.g. 0.1 + 0.2 !== 0.3). Using doubles for money,
 * prices, quantities, fees, or P&L risks silently corrupting trading decisions.
 *
 * To avoid this, `Money` stores a value as an integer scaled to a fixed number
 * of decimal places (scale). Arithmetic is performed with BigInt, which is exact.
 *
 * Choices:
 * - A fixed scale (default 8) is used for all values. This matches typical
 *   cryptocurrency precision (e.g. BTC to 8 decimals, quote to 2 decimals).
 *   A single uniform scale keeps arithmetic simple and predictable.
 * - We deliberately do NOT use a third-party arbitrary-precision library here.
 *   Financial operations in the trading core are add/sub/compare/multiply-by-
 *   small-integer or -fraction, which fixed-point BigInt handles exactly.
 *   Advanced operations (log, sqrt, pow) needed by some strategies can be added
 *   later or delegated, without changing how prices/amounts are stored.
 *
 * This type is immutable: all operations return new instances.
 */

export interface MoneyScaledBy {
  readonly scaled: bigint;
}

const DEFAULT_SCALE = 8n;
const SCALE_POW = 10n ** DEFAULT_SCALE;

export class Money {
  /** The scaled integer value. `scaled / 10^scale` is the human value. */
  readonly scaled: bigint;
  readonly scale: bigint = DEFAULT_SCALE;

  private constructor(scaled: bigint) {
    this.scaled = scaled;
  }

  /** Build from an exact decimal string, e.g. "1234.5678". */
  static fromString(input: string): Money {
    const trimmed = input.trim();
    if (trimmed === '') {
      throw new Error('Money.fromString: empty string');
    }
    if (!/^[+-]?(\d+)(\.\d*)?$/.test(trimmed)) {
      throw new Error(`Money.fromString: invalid decimal string "${input}"`);
    }
    const negative = trimmed.startsWith('-');
    const abs = trimmed.replace(/^[+-]/, '');
    const [intPart = '0', fracPart = ''] = abs.split('.');
    if (fracPart.length > Number(DEFAULT_SCALE)) {
      // Round half-up to the supported scale rather than silently truncating.
      const keep = fracPart.slice(0, Number(DEFAULT_SCALE));
      const drop = fracPart.slice(Number(DEFAULT_SCALE));
      const scaled = BigInt(intPart) * SCALE_POW + BigInt(keep);
      const rounded = scaled + (BigInt(drop[0] ?? '0') >= 5n ? 1n : 0n);
      return new Money(negative ? -rounded : rounded);
    }
    const scaled =
      BigInt(intPart) * SCALE_POW + BigInt(fracPart.padEnd(Number(DEFAULT_SCALE), '0'));
    return new Money(negative ? -scaled : scaled);
  }

  /** Build from a raw number. Prefer fromString when the source is text. */
  static fromNumber(input: number): Money {
    if (!Number.isFinite(input)) {
      throw new Error('Money.fromNumber: input must be finite');
    }
    return Money.fromString(String(input));
  }

  /** Build directly from a scaled integer (e.g. raw exchange integer units). */
  static fromScaled(scaled: bigint): Money {
    return new Money(scaled);
  }

  static zero(): Money {
    return new Money(0n);
  }

  static max(a: Money, b: Money): Money {
    return a.compareTo(b) >= 0 ? a : b;
  }

  static min(a: Money, b: Money): Money {
    return a.compareTo(b) <= 0 ? a : b;
  }

  add(other: Money): Money {
    return new Money(this.scaled + other.scaled);
  }

  sub(other: Money): Money {
    return new Money(this.scaled - other.scaled);
  }

  negate(): Money {
    return new Money(-this.scaled);
  }

  /**
   * Multiply by an exact fraction (numerator/denominator) using BigInt.
   * E.g. factor(1, 4) = 0.25. Handles percentage/fraction-based sizing
   * without floating point.
   */
  mulFraction(numerator: bigint, denominator: bigint): Money {
    if (denominator === 0n) {
      throw new Error('Money.mulFraction: denominator cannot be zero');
    }
    const product = this.scaled * numerator;
    // Integer division, truncating toward zero.
    let result = product / denominator;
    const remainder = product % denominator;
    if (remainder !== 0n && (product < 0n) !== (denominator < 0n)) {
      result -= 1n;
    }
    return new Money(result);
  }

  /** Multiply by a small integer, exact. */
  mulInt(n: bigint): Money {
    return new Money(this.scaled * n);
  }

  /**
   * Multiply by another same-scale value, producing a same-scale result.
   * The raw product of two scale-8 values is scale-16; we divide back by the
   * scale power and round half-up to the nearest unit. Exact to the supported
   * scale (no floating point). Used e.g. for quantity * price = notional.
   */
  mul(other: Money): Money {
    const negative = this.scaled < 0n !== other.scaled < 0n;
    const absA = this.scaled < 0n ? -this.scaled : this.scaled;
    const absB = other.scaled < 0n ? -other.scaled : other.scaled;
    let quotient = (absA * absB) / SCALE_POW;
    const remainder = (absA * absB) % SCALE_POW;
    if (remainder * 2n >= SCALE_POW) quotient += 1n;
    return new Money(negative ? -quotient : quotient);
  }

  /**
   * Divide by another same-scale value, producing a same-scale result
   * (rescaling the numerator up first). Truncates toward zero. Used e.g. for
   * notional / price = quantity.
   */
  div(other: Money): Money {
    if (other.scaled === 0n) {
      throw new Error('Money.div: cannot divide by zero');
    }
    return new Money((this.scaled * SCALE_POW) / other.scaled);
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isPositive(): boolean {
    return this.scaled > 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  isNegativeOrZero(): boolean {
    return this.scaled <= 0n;
  }

  compareTo(other: Money): number {
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.scaled === other.scaled;
  }

  /**
   * Format to a plain decimal string with a fixed number of decimal places.
   */
  toFixed(decimals: number): string {
    const scale = Number(this.scale);
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;

    // displayInt = the integer whose last `decimals` digits are the fraction.
    let displayInt: bigint;
    if (decimals <= scale) {
      displayInt = abs / 10n ** BigInt(scale - decimals);
    } else {
      displayInt = abs * 10n ** BigInt(decimals - scale);
    }

    if (decimals <= 0) {
      return `${negative ? '-' : ''}${displayInt}`;
    }

    const pow = 10n ** BigInt(decimals);
    const intPart = displayInt / pow;
    const fracPart = (displayInt % pow).toString().padStart(decimals, '0');
    return `${negative ? '-' : ''}${intPart}.${fracPart}`;
  }

  toString(): string {
    return this.toFixed(Number(this.scale));
  }

  /**
   * Round this value to the nearest multiple of `increment` (a tick size).
   * Exact, BigInt-based. Useful for respecting an exchange's price/quantity
   * tick sizes before placing an order. Rounding is half-up on the magnitude,
   * preserving sign.
   */
  roundToIncrement(increment: Money): Money {
    if (increment.scaled <= 0n) {
      throw new Error('Money.roundToIncrement: increment must be positive');
    }
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;
    const inc = increment.scaled;
    const quotient = abs / inc;
    const remainder = abs % inc;
    const rounded = remainder * 2n >= inc ? quotient + 1n : quotient;
    return new Money((negative ? -rounded : rounded) * inc);
  }

  /**
   * Round this value DOWN to the nearest multiple of `increment` (a tick size).
   * Never rounds toward a larger magnitude, so a sized quantity can never exceed
   * the cap that produced it. Exact, BigInt-based. For positive values this is a
   * plain floor; sign is preserved (rounds toward zero on the magnitude).
   */
  floorToIncrement(increment: Money): Money {
    if (increment.scaled <= 0n) {
      throw new Error('Money.floorToIncrement: increment must be positive');
    }
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;
    const quotient = abs / increment.scaled;
    return new Money((negative ? -quotient : quotient) * increment.scaled);
  }

  /**
   * True if this value is an exact multiple of `increment` (i.e. already on
   * the allowed tick grid).
   */
  isMultipleOf(increment: Money): boolean {
    if (increment.scaled <= 0n) {
      throw new Error('Money.isMultipleOf: increment must be positive');
    }
    return this.scaled % increment.scaled === 0n;
  }

  /** Exact integer value (lossy if scaled exceeds 2^53, but exact for money). */
  toNumber(): number {
    return Number(this.scaled) / Number(SCALE_POW);
  }

  /**
   * JSON serialization as a decimal string (exact). This makes any object
   * containing Money JSON-safe without BigInt serialization errors, at the cost
   * of the consumer re-parsing decimal strings into `Money` where needed.
   */
  toJSON(): string {
    return this.toString();
  }
}
