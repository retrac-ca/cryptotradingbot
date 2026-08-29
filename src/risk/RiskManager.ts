/**
 * RiskManager — the deterministic gate between strategy signals and execution.
 *
 * A strategy only ever produces a `Signal`; it NEVER decides order size or
 * enforces account-level risk limits. That is this module's job. Given a
 * `Signal` and a `RiskContext` snapshot, it decides:
 *
 *   - whether the trade is permitted (and the typed reason if not), and
 *   - what quantity/size is permitted (the risk layer, not the strategy, sizes
 *     the order), so a strategy cannot bypass risk controls by requesting an
 *     arbitrary size.
 *
 * Design principles:
 *   - Fail closed: whenever a required input is unavailable/unreliable, reject.
 *   - Deterministic & pure: no I/O; results depend only on inputs + state.
 *   - Risk-reducing SELLs are allowed even when new exposure is prohibited.
 *   - Long-only for V1 (no shorting); a SELL never exceeds the held position.
 */

import type { Money } from '../money/Money.js';
import { Money as MoneyValue } from '../money/Money.js';
import { OrderSide } from '../order.js';
import { signalToOrderSide } from '../strategy/Signal.js';
import type { RiskConfig } from './RiskConfig.js';
import type { RiskContext } from './RiskContext.js';
import { RISK_REASON, type AppliedRiskLimits, type RiskDecision } from './Reason.js';

interface Cap {
  reason: (typeof RISK_REASON)[number];
  notional: Money; // remaining permitted notional under this cap
}

const FRACTION_SCALE = 1_000_000_000n;
const FRACTION_DIVISOR = 1_000_000_000n;

export class RiskManager {
  private readonly cfg: RiskConfig;
  private killSwitchActive = false;
  private cooldownUntilMs: number | null = null;

  constructor(cfg: RiskConfig) {
    this.cfg = cfg;
  }

  // --- Runtime state ---

  /**
   * Enable/disable the kill switch. Enabled is sticky: it only turns off when a
   * caller explicitly calls `setKillSwitch(false)`, which reflects that
   * disarming must be a deliberate action.
   */
  setKillSwitch(active: boolean): void {
    this.killSwitchActive = active;
  }

  getKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  /** Record a losing trade / risk event, starting a cooldown window. */
  recordLoss(nowMs: number): void {
    this.cooldownUntilMs = nowMs + this.cfg.cooldownAfterLossMs;
  }

  /** Remaining cooldown (ms) at the given time, or 0 if none. */
  remainingCooldownMs(nowMs: number): number {
    if (this.cooldownUntilMs === null) return 0;
    const remaining = this.cooldownUntilMs - nowMs;
    return remaining > 0 ? remaining : 0;
  }

  private appliedLimits(): AppliedRiskLimits {
    return {
      maxTradeAmount: this.cfg.maxTradeAmount,
      maxPositionSizeFraction: this.cfg.maxPositionSizeFraction,
      maxPortfolioExposureFraction: this.cfg.maxPortfolioExposureFraction,
      maxDailyLossFraction: this.cfg.maxDailyLossFraction,
      maxDrawdownFraction: this.cfg.maxDrawdownFraction,
      cooldownAfterLossMs: this.cfg.cooldownAfterLossMs,
      killSwitchActive: this.killSwitchActive,
    };
  }

  /** Compute `fraction * money` exactly-ish (fraction resolved to 9 decimals). */
  private static fractionOf(money: Money, fraction: number): Money {
    const num = BigInt(Math.round(fraction * Number(FRACTION_SCALE)));
    return money.mulFraction(num, FRACTION_DIVISOR);
  }

  private reject(
    symbol: string,
    side: OrderSide | null,
    reason: (typeof RISK_REASON)[number],
    detail?: string,
  ): RiskDecision {
    return {
      approved: false,
      symbol,
      side,
      reason,
      ...(detail ? { detail } : {}),
      appliedLimits: this.appliedLimits(),
    };
  }

  /**
   * Evaluate a signal against the snapshot and produce a risk decision.
   */
  evaluate(ctx: RiskContext): RiskDecision {
    const limits = this.appliedLimits();

    // Kill switch: immediate, unconditional.
    if (this.killSwitchActive) {
      return this.reject(ctx.symbol, signalToOrderSide(ctx.signal.type), 'KILL_SWITCH_ACTIVE');
    }

    // Nothing to do.
    if (ctx.signal.type === 'HOLD') {
      return this.reject(ctx.symbol, null, 'NO_ACTION');
    }

    const side = signalToOrderSide(ctx.signal.type);
    if (side === null) {
      return this.reject(ctx.symbol, null, 'NO_ACTION');
    }

    // Core inputs every non-trivial decision needs.
    if (ctx.marketInfo === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_MARKET_INFO');
    }
    if (ctx.price === null || !ctx.price.isPositive()) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_PRICE');
    }
    if (ctx.currentPosition === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_POSITION');
    }
    if (
      ctx.marketDataTimestampMs === null ||
      ctx.nowMs - ctx.marketDataTimestampMs > this.cfg.marketDataMaxAgeMs
    ) {
      return this.reject(ctx.symbol, side, 'STALE_MARKET_DATA');
    }

    // Branch by intent: SELL that reduces exposure is treated more permissively.
    if (side === 'SELL') {
      return this.evaluateSell(ctx, side, limits);
    }
    return this.evaluateBuy(ctx, side, limits);
  }

  // --- SELL (risk-reducing) ---

  private evaluateSell(ctx: RiskContext, side: OrderSide, limits: AppliedRiskLimits): RiskDecision {
    const position = ctx.currentPosition!;

    if (position.isZero()) {
      return this.reject(ctx.symbol, side, 'NO_ACTION', 'no position to sell');
    }
    if (position.isNegative()) {
      return this.reject(ctx.symbol, side, 'SELL_EXCEEDS_POSITION', 'cannot sell a short/negative position');
    }

    // Risk-reducing: closing a long. We size to the full held position (the
    // cross-over strategy's SELL means "exit the long"), never shrinking it by
    // accident or selling more than we hold.
    const quantity = position.floorToIncrement(ctx.marketInfo!.quantityTick);
    if (quantity.isZero()) {
      return this.reject(ctx.symbol, side, 'BELOW_MIN_QUANTITY', 'position smaller than one quantity tick');
    }

    const marketCheck = this.validateMarketQuantity(ctx, side, quantity);
    if (marketCheck !== null) return marketCheck;

    const notional = quantity.mul(ctx.price!).floorToIncrement(ctx.marketInfo!.priceTick);
    return {
      approved: true,
      symbol: ctx.symbol,
      side,
      quantity,
      estimatedNotional: notional,
      price: ctx.price!,
      reason: 'APPROVED',
      appliedLimits: limits,
    };
  }

  // --- BUY (opens/increases exposure) ---

  private evaluateBuy(ctx: RiskContext, side: OrderSide, limits: AppliedRiskLimits): RiskDecision {
    const price = ctx.price!;
    const market = ctx.marketInfo!;

    // --- Account/portfolio state required for exposure accounting. ---
    if (ctx.portfolioValue === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_PORTFOLIO_VALUE');
    }
    if (ctx.portfolioExposure === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_EXPOSURE');
    }
    if (ctx.quoteBalance === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_BALANCE');
    }

    // --- Risk-reduction / global loss gates (reject new exposure). ---
    const dailyLossGate = this.checkDailyLoss(ctx, side, limits);
    if (dailyLossGate !== null) return dailyLossGate;
    const drawdownGate = this.checkDrawdown(ctx, side, limits);
    if (drawdownGate !== null) return drawdownGate;
    const cooldownGate = this.checkCooldown(ctx, side, limits);
    if (cooldownGate !== null) return cooldownGate;

    // --- Sizing: compute the permitted notional. ---
    const caps = this.computeBuyCaps(ctx, limits);
    if (caps.notional.isNegativeOrZero()) {
      // No room left under the binding cap; reject with that cap's reason.
      return this.reject(ctx.symbol, side, caps.reason);
    }

    const desiredNotional = caps.notional;
    const quantity = desiredNotional.div(price).floorToIncrement(market.quantityTick);

    // An amount this small is not worth / not valid to trade.
    if (!quantity.isPositive()) {
      return this.reject(ctx.symbol, side, 'BELOW_MIN_QUANTITY', 'computed quantity rounds to zero');
    }

    const marketCheck = this.validateMarketQuantity(ctx, side, quantity);
    if (marketCheck !== null) return marketCheck;

    const notional = quantity.mul(price).floorToIncrement(market.priceTick);

    // Funding check (fail closed on insufficient available balance).
    if (ctx.quoteBalance.available.compareTo(notional) < 0) {
      return this.reject(ctx.symbol, side, 'INSUFFICIENT_BALANCE');
    }

    return {
      approved: true,
      symbol: ctx.symbol,
      side,
      quantity,
      estimatedNotional: notional,
      price,
      reason: 'APPROVED',
      appliedLimits: limits,
    };
  }

  /**
   * Determine remaining permitted notional under each cap and return the
   * binding cap (the smallest). A non-positive `notional` means there is no
   * room left to trade under that (now binding) cap.
   */
  private computeBuyCaps(
    ctx: RiskContext,
    limits: AppliedRiskLimits,
  ): { reason: (typeof RISK_REASON)[number]; notional: Money } {
    const price = ctx.price!;
    const portfolioValue = ctx.portfolioValue!;
    const position = ctx.currentPosition!;

    const caps: Cap[] = [];

    // Per-asset position cap (fraction of portfolio, measured in base units).
    if (limits.maxPositionSizeFraction > 0) {
      const maxPositionBase = RiskManager.fractionOf(portfolioValue, limits.maxPositionSizeFraction).div(price);
      const remainingBase = maxPositionBase.sub(position);
      caps.push({ reason: 'MAX_POSITION_EXCEEDED', notional: remainingBase.mul(price) });
    }

    // Portfolio exposure cap (fraction of portfolio, total notional).
    if (limits.maxPortfolioExposureFraction > 0) {
      const maxExposure = RiskManager.fractionOf(portfolioValue, limits.maxPortfolioExposureFraction);
      const remaining = maxExposure.sub(ctx.portfolioExposure!);
      caps.push({ reason: 'MAX_PORTFOLIO_EXPOSURE_EXCEEDED', notional: remaining });
    }

    // Per-trade notional cap.
    if (limits.maxTradeAmount.isPositive()) {
      caps.push({ reason: 'MAX_TRADE_EXCEEDED', notional: limits.maxTradeAmount });
    }

    if (caps.length === 0) {
      caps.push({ reason: 'MAX_POSITION_EXCEEDED', notional: MoneyValue.zero() });
    }

    // The binding cap is the one with the smallest remaining notional.
    let binding = caps[0]!;
    for (const cap of caps) {
      if (cap.notional.compareTo(binding.notional) < 0) binding = cap;
    }

    return { reason: binding.reason, notional: binding.notional };
  }

  // --- Fail-closed adjustments via sizing (not rejection): handled by caps. ---

  /** Validate quantity against exchange constraints; returns a rejection or null. */
  private validateMarketQuantity(
    ctx: RiskContext,
    side: OrderSide,
    quantity: Money,
  ): RiskDecision | null {
    const market = ctx.marketInfo!;

    if (!quantity.isPositive()) {
      return this.reject(ctx.symbol, side, 'INVALID_QUANTITY', 'quantity must be positive');
    }

    if (!quantity.isMultipleOf(market.quantityTick)) {
      return this.reject(ctx.symbol, side, 'PRECISION_VIOLATION', 'quantity not a multiple of quantity tick');
    }

    if (market.minOrderBase !== null && quantity.compareTo(market.minOrderBase) < 0) {
      return this.reject(ctx.symbol, side, 'BELOW_MIN_QUANTITY');
    }

    if (market.priceTick.isPositive() && !ctx.price!.isMultipleOf(market.priceTick)) {
      return this.reject(ctx.symbol, side, 'PRECISION_VIOLATION', 'price not a multiple of price tick');
    }

    return null;
  }

  /** Daily loss limit gate (BUY only). Returns a rejection or null. */
  private checkDailyLoss(ctx: RiskContext, side: OrderSide, limits: AppliedRiskLimits): RiskDecision | null {
    if (limits.maxDailyLossFraction <= 0) return null;
    const realized = ctx.realizedPnlToday;
    const unrealized = ctx.unrealizedPnlToday;
    if (realized === null || unrealized === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_PNL');
    }
    const loss = realized.add(unrealized); // negative => loss
    if (!loss.isNegative()) return null;
    const limit = RiskManager.fractionOf(ctx.portfolioValue!, limits.maxDailyLossFraction);
    if (loss.negate().compareTo(limit) >= 0) {
      return this.reject(ctx.symbol, side, 'DAILY_LOSS_LIMIT_EXCEEDED');
    }
    return null;
  }

  /** Max drawdown gate (BUY only). Returns a rejection or null. */
  private checkDrawdown(ctx: RiskContext, side: OrderSide, limits: AppliedRiskLimits): RiskDecision | null {
    if (limits.maxDrawdownFraction <= 0) return null;
    const peak = ctx.peakPortfolioValue;
    const current = ctx.portfolioValue;
    if (peak === null || current === null) {
      return this.reject(ctx.symbol, side, 'UNKNOWN_PEAK');
    }
    if (peak.isNegativeOrZero()) return null;
    // Reject when current has fallen to or below (1 - limit) * peak.
    const denialLevel = RiskManager.fractionOf(
      peak,
      1 - limits.maxDrawdownFraction,
    );
    if (current.compareTo(denialLevel) <= 0) {
      return this.reject(ctx.symbol, side, 'MAX_DRAWDOWN_EXCEEDED');
    }
    return null;
  }

  /** Cooldown gate (BUY only). Returns a rejection or null. */
  private checkCooldown(ctx: RiskContext, side: OrderSide, limits: AppliedRiskLimits): RiskDecision | null {
    if (limits.cooldownAfterLossMs <= 0) return null;
    if (this.remainingCooldownMs(ctx.nowMs) > 0) {
      return this.reject(ctx.symbol, side, 'COOLDOWN_ACTIVE');
    }
    return null;
  }
}
