import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import { RiskManager } from '../../../src/risk/RiskManager.js';
import type { RiskConfig } from '../../../src/risk/RiskConfig.js';
import type { RiskContext } from '../../../src/risk/RiskContext.js';
import { signal } from '../../../src/strategy/Signal.js';
import type { MarketInfo } from '../../../src/types.js';
import type { Balance } from '../../../src/types.js';

// --- Fixtures ---

const PRICE = Money.fromString('40000.00');
const PORTFOLIO = Money.fromString('100000.00');
const QUANTITY_TICK = Money.fromString('0.00001');
const PRICE_TICK = Money.fromString('0.01');
const MIN_BASE = Money.fromString('0.0001');

const marketInfo: MarketInfo = {
  symbol: 'BTC/CAD',
  exchangeId: '1',
  priceTick: PRICE_TICK,
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: QUANTITY_TICK,
  minOrderBase: MIN_BASE,
  minOrderQuote: null,
  supportsMarketOrders: true,
  feeInfo: null,
};

const balance = (available: string): Balance => ({
  currency: 'CAD',
  total: Money.fromString(available),
  available: Money.fromString(available),
  held: Money.zero(),
});

const baseConfig: RiskConfig = {
  maxTradeAmount: Money.zero(), // no explicit per-trade cap
  maxPositionSizeFraction: 0.1,
  maxPortfolioExposureFraction: 0.5,
  maxDailyLossFraction: 0.05,
  maxDrawdownFraction: 0.1,
  cooldownAfterLossMs: 3600_000,
  maxOpenPositions: 1,
  marketDataMaxAgeMs: 60_000,
  marketDataTransportMaxAgeMs: 60_000,
  maxClockSkewMs: 120_000,
};

const NOW = 1_000_000_000;

type Overrides = Partial<RiskContext>;

function ctx(signalType: 'BUY' | 'SELL' | 'HOLD', over: Overrides = {}): RiskContext {
  return {
    symbol: 'BTC/CAD',
    signal: signal('BTC/CAD', signalType, {}, NOW),
    nowMs: NOW,
    marketDataTimestampMs: NOW,
    marketDataObservedAtMs: NOW,
    price: PRICE,
    marketInfo,
    quoteBalance: balance('100000'),
    deployableQuote: Money.fromString('100000'),
    portfolioValue: PORTFOLIO,
    peakPortfolioValue: PORTFOLIO,
    portfolioExposure: Money.zero(),
    currentPosition: Money.zero(),
    externalPosition: Money.zero(),
    openManagedPositionCount: 0,
    realizedPnlToday: Money.zero(),
    unrealizedPnlToday: Money.zero(),
    ...over,
  };
}

function mk(cfg: Partial<RiskConfig> = {}): RiskManager {
  return new RiskManager({ ...baseConfig, ...cfg });
}

// --- Core / approval ---

describe('RiskManager — approval & sizing', () => {
  it('approves a BUY within limits and sizes it to the position cap', () => {
    const d = mk().evaluate(ctx('BUY'));
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.side).toBe('BUY');
      // 10% of 100k = 10k CAD / 40000 = 0.25 BTC
      expect(d.quantity.toFixed(8)).toBe('0.25000000');
      expect(d.estimatedNotional.toFixed(2)).toBe('10000.00');
      expect(d.reason).toBe('APPROVED');
    }
  });

  it('sizes to the binding exposure cap, not the position cap', () => {
    const d = mk().evaluate(
      ctx('BUY', { portfolioExposure: Money.fromString('45000.00') }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) {
      // exposure cap leaves 5000 CAD -> 0.125 BTC
      expect(d.quantity.toFixed(8)).toBe('0.12500000');
      expect(d.estimatedNotional.toFixed(2)).toBe('5000.00');
    }
  });

  it('sizes to the smaller explicit max trade amount', () => {
    const d = mk({ maxTradeAmount: Money.fromString('2000.00') }).evaluate(ctx('BUY'));
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.estimatedNotional.toFixed(2)).toBe('2000.00');
      expect(d.quantity.toFixed(8)).toBe('0.05000000');
    }
  });

  it('approves a SELL that reduces a long position, sized to the held position', () => {
    const d = mk().evaluate(ctx('SELL', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.quantity.toFixed(8)).toBe('0.25000000');
      expect(d.estimatedNotional.toFixed(2)).toBe('10000.00');
    }
  });

  it('HOLD signal yields NO_ACTION', () => {
    const d = mk().evaluate(ctx('HOLD'));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('NO_ACTION');
  });

  it('does not let a large balance inflate the position beyond the cap', () => {
    const d = mk().evaluate(ctx('BUY', { quoteBalance: balance('100000000') }));
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.quantity.toFixed(8)).toBe('0.25000000');
    }
  });
});

// --- Kill switch ---

describe('RiskManager — kill switch', () => {
  it('rejects everything on the first check when the kill switch is active', () => {
    const risk = mk();
    risk.setKillSwitch(true);
    const d = risk.evaluate(ctx('BUY'));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('KILL_SWITCH_ACTIVE');
  });

  it('rejects risk-reducing SELLs too while the kill switch is active', () => {
    const risk = mk();
    risk.setKillSwitch(true);
    const d = risk.evaluate(ctx('SELL', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('KILL_SWITCH_ACTIVE');
  });

  it('is sticky and only clears on an explicit disable', () => {
    const risk = mk();
    risk.setKillSwitch(true);
    expect(risk.getKillSwitchActive()).toBe(true);
    risk.setKillSwitch(false);
    expect(risk.getKillSwitchActive()).toBe(false);
  });
});

// --- Daily loss ---

describe('RiskManager — daily loss limit', () => {
  it('rejects a BUY when realized + unrealized loss reaches the limit', () => {
    // limit = 5% of 100k = 5000
    const d = mk().evaluate(
      ctx('BUY', {
        realizedPnlToday: Money.fromString('-4000'),
        unrealizedPnlToday: Money.fromString('-1000'),
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('DAILY_LOSS_LIMIT_EXCEEDED');
  });

  it('rejects at the exact boundary (loss == limit)', () => {
    const d = mk().evaluate(
      ctx('BUY', { realizedPnlToday: Money.fromString('-5000'), unrealizedPnlToday: Money.zero() }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('DAILY_LOSS_LIMIT_EXCEEDED');
  });

  it('allows a BUY below the daily loss limit', () => {
    const d = mk().evaluate(
      ctx('BUY', { realizedPnlToday: Money.fromString('-4999.99'), unrealizedPnlToday: Money.zero() }),
    );
    expect(d.approved).toBe(true);
  });

  it('does not block a risk-reducing SELL during a loss', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        realizedPnlToday: Money.fromString('-9000'),
        unrealizedPnlToday: Money.zero(),
      }),
    );
    expect(d.approved).toBe(true);
  });

  it('fails closed when P&L is unknown for a BUY', () => {
    const d = mk().evaluate(
      ctx('BUY', { realizedPnlToday: null, unrealizedPnlToday: null }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_PNL');
  });
});

// --- Drawdown ---

describe('RiskManager — max drawdown', () => {
  it('rejects a BUY when drawdown from peak reaches the threshold', () => {
    // peak 100k, threshold 10% -> reject at/below 90k
    const d = mk().evaluate(ctx('BUY', { portfolioValue: Money.fromString('90000.00') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('MAX_DRAWDOWN_EXCEEDED');
  });

  it('allows a BUY slightly above the drawdown threshold', () => {
    const d = mk().evaluate(ctx('BUY', { portfolioValue: Money.fromString('90000.01') }));
    expect(d.approved).toBe(true);
  });

  it('fails closed when peak is unknown for a BUY', () => {
    const d = mk().evaluate(ctx('BUY', { peakPortfolioValue: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_PEAK');
  });

  it('allows a risk-reducing SELL during a drawdown', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        portfolioValue: Money.fromString('80000.00'),
      }),
    );
    expect(d.approved).toBe(true);
  });
});

// --- Cooldown ---

describe('RiskManager — cooldown', () => {
  it('rejects a BUY while within the cooldown after a loss', () => {
    const risk = mk();
    risk.recordLoss(NOW);
    expect(risk.remainingCooldownMs(NOW)).toBe(3600_000);
    const d = risk.evaluate(ctx('BUY'));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('COOLDOWN_ACTIVE');
  });

  it('allows a BUY again after the cooldown expires', () => {
    const risk = mk();
    risk.recordLoss(NOW);
    const later = NOW + 3600_000;
    const d = risk.evaluate(ctx('BUY', { nowMs: later, marketDataTimestampMs: later, marketDataObservedAtMs: later }));
    expect(d.approved).toBe(true);
  });

  it('allows a risk-reducing SELL during a cooldown', () => {
    const risk = mk();
    risk.recordLoss(NOW);
    const d = risk.evaluate(ctx('SELL', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(true);
  });
});

// --- Position / exposure caps ---

describe('RiskManager — position & exposure caps', () => {
  it('rejects a BUY when the position already equals the max', () => {
    const d = mk().evaluate(ctx('BUY', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('MAX_POSITION_EXCEEDED');
  });

  it('sizes a BUY to fill the remaining room under the position cap', () => {
    const d = mk().evaluate(ctx('BUY', { currentPosition: Money.fromString('0.125') }));
    expect(d.approved).toBe(true);
    if (d.approved) {
      // room left = 0.125 BTC
      expect(d.quantity.toFixed(8)).toBe('0.12500000');
    }
  });

  it('rejects a BUY when portfolio exposure already equals the cap', () => {
    const d = mk().evaluate(ctx('BUY', { portfolioExposure: Money.fromString('50000.00') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('MAX_PORTFOLIO_EXPOSURE_EXCEEDED');
  });

  it('fails closed when exposure is unknown', () => {
    const d = mk().evaluate(ctx('BUY', { portfolioExposure: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_EXPOSURE');
  });
});

// --- Trade size ---

describe('RiskManager — max trade size', () => {
  it('rejects a BUY when the binding cap is the trade cap and it has no room', () => {
    // exposure at 49999 (1 CAD room), trade cap 0 -> reject trade cap? trade cap disabled.
    const d = mk({ maxTradeAmount: Money.fromString('0.001') }).evaluate(ctx('BUY'));
    expect(d.approved).toBe(false);
  });

  it('rejects a BUY when the implicit position room is zero', () => {
    const d = mk().evaluate(ctx('BUY', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(false);
  });
});

// --- Balance ---

describe('RiskManager — balance', () => {
  it('rejects a BUY when available balance is insufficient', () => {
    const d = mk().evaluate(ctx('BUY', { deployableQuote: Money.fromString('100') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('fails closed when balance is unknown', () => {
    const d = mk().evaluate(ctx('BUY', { quoteBalance: null, deployableQuote: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_BALANCE');
  });

  it('does not need balance for a risk-reducing SELL', () => {
    const d = mk().evaluate(
      ctx('SELL', { currentPosition: Money.fromString('0.25'), quoteBalance: null }),
    );
    expect(d.approved).toBe(true);
  });
});

// --- Market validation / staleness ---

describe('RiskManager — market validation & staleness', () => {
  it('rejects on missing market info', () => {
    const d = mk().evaluate(ctx('BUY', { marketInfo: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_MARKET_INFO');
  });

  it('rejects a BUY when market data is stale', () => {
    const d = mk().evaluate(ctx('BUY', { marketDataTimestampMs: NOW - 61_000 }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('STALE_MARKET_DATA');
  });

  it('rejects when price is unknown', () => {
    const d = mk().evaluate(ctx('BUY', { price: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_PRICE');
  });

  it('rejects when price is not a multiple of the price tick (bad precision)', () => {
    const d = mk().evaluate(ctx('BUY', { price: Money.fromString('40000.005') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('PRECISION_VIOLATION');
  });

  it('rejects a SELL of a position smaller than min quantity', () => {
    const d = mk().evaluate(ctx('SELL', { currentPosition: Money.fromString('0.00005') }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('BELOW_MIN_QUANTITY');
  });

  it('rejects a BUY that rounds to zero quantity below min tick', () => {
    const d = mk({ maxTradeAmount: Money.fromString('0.00000001') }).evaluate(ctx('BUY'));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('BELOW_MIN_QUANTITY');
  });

  it('rejects a SELL when there is nothing held (flat)', () => {
    const d = mk().evaluate(ctx('SELL', { currentPosition: Money.zero() }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('NO_ACTION');
  });
});

// --- Unknown state / fail closed ---

describe('RiskManager — fail closed on unknown state', () => {
  it('rejects a BUY when position is unknown', () => {
    const d = mk().evaluate(ctx('BUY', { currentPosition: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_POSITION');
  });

  it('rejects a BUY when portfolio value is unknown', () => {
    const d = mk().evaluate(ctx('BUY', { portfolioValue: null }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('UNKNOWN_PORTFOLIO_VALUE');
  });
});

// --- Multiple rules / bypass ---

describe('RiskManager — combinations & cannot-bypass', () => {
  it('reports the first gate when several fail simultaneously', () => {
    const d = mk().evaluate(
      ctx('BUY', {
        realizedPnlToday: Money.fromString('-9000'),
        unrealizedPnlToday: Money.zero(),
        portfolioValue: Money.fromString('80000.00'),
        currentPosition: Money.fromString('0.25'),
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('DAILY_LOSS_LIMIT_EXCEEDED');
  });

  it('cannot be bypassed by an unusual price pushing the notional past the cap', () => {
    // A different (still on-tick) price must not let the trade exceed the 10k
    // notional position cap.
    const d = mk().evaluate(ctx('BUY', { price: Money.fromString('41000.00') }));
    expect(d.approved).toBe(true);
    if (d.approved) {
      expect(d.estimatedNotional.compareTo(Money.fromString('10000.00'))).toBeLessThanOrEqual(0);
      expect(d.quantity.toFixed(8)).toBe('0.24390000'); // 10000 / 41000 floored to tick
    }
  });

  it('records applied limits on every decision', () => {
    const d = mk().evaluate(ctx('BUY'));
    const limits = d.approved ? d.appliedLimits : d.appliedLimits;
    expect(limits.maxPositionSizeFraction).toBe(0.1);
    expect(limits.maxPortfolioExposureFraction).toBe(0.5);
    expect(limits.maxDailyLossFraction).toBe(0.05);
    expect(limits.killSwitchActive).toBe(false);
  });
});

// --- Bounded partial SELL (live-test / operator hedge) ---

describe('RiskManager — bounded partial SELL (sellTarget)', () => {
  it('sizes a partial exit down to a notional target (never exceeds it)', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        sellTarget: { notional: Money.fromString('5000') },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) {
      // 5000 / 40000 = 0.125 BTC, floored to tick.
      expect(d.quantity.toFixed(8)).toBe('0.12500000');
      expect(d.estimatedNotional.compareTo(Money.fromString('5000.00'))).toBeLessThanOrEqual(0);
    }
  });

  it('sells only the target fraction of the held position', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        sellTarget: { fraction: 0.5 },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.12500000');
  });

  it('caps the target at the held position (no shorting / no over-sell)', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        sellTarget: { notional: Money.fromString('100000') },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.25000000');
  });

  it('uses the smallest bound when both fraction and notional are given', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        // fraction 0.5 -> 0.125; notional 2000 -> 0.05. Smallest binds.
        sellTarget: { fraction: 0.5, notional: Money.fromString('2000') },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.05000000');
  });

  it('floors the target to the quantity tick (operator cannot inject an arbitrary quantity)', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        sellTarget: { notional: Money.fromString('100') },
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.00250000');
  });

  it('rejects a target too small to clear the min quantity', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        sellTarget: { notional: Money.fromString('1') }, // 0.000025 -> 0.00001 < min 0.0001
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('BELOW_MIN_QUANTITY');
  });

  it('rejects a malformed (empty) sell target', () => {
    const d = mk().evaluate(
      ctx('SELL', { currentPosition: Money.fromString('0.25'), sellTarget: {} }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('INVALID_SELL_TARGET');
  });

  it('rejects out-of-range fractions and non-positive notionals', () => {
    for (const sellTarget of [
      { fraction: 0 },
      { fraction: -0.1 },
      { fraction: 1.5 },
      { notional: Money.zero() },
      { notional: Money.fromString('-5') },
    ]) {
      const d = mk().evaluate(
        ctx('SELL', { currentPosition: Money.fromString('0.25'), sellTarget }),
      );
      expect(d.approved).toBe(false);
      if (!d.approved) expect(d.reason).toBe('INVALID_SELL_TARGET');
    }
  });

  it('ignores sellTarget on a BUY (it only bounds the risk-reducing SELL path)', () => {
    const d = mk().evaluate(
      ctx('BUY', { sellTarget: { notional: Money.fromString('1') } }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.25000000');
  });

  it('still performs a full exit when no sellTarget is present', () => {
    const d = mk().evaluate(ctx('SELL', { currentPosition: Money.fromString('0.25') }));
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.25000000');
  });
});

// --- Hybrid freshness (Gate 4) ---

describe('RiskManager — hybrid market-data freshness', () => {
  it('fails closed when the transport is fresh but the quote is stale', () => {
    const d = mk().evaluate(
      ctx('BUY', {
        marketDataTimestampMs: NOW - 61_000,
        marketDataObservedAtMs: NOW,
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe('STALE_MARKET_DATA');
      expect(d.detail).toContain('QUOTE_STALE');
    }
  });

  it('fails closed when the quote is fresh but the transport is stale', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        marketDataTimestampMs: NOW,
        marketDataObservedAtMs: NOW - 61_000,
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe('STALE_MARKET_DATA');
      expect(d.detail).toContain('TRANSPORT_STALE');
    }
  });

  it('fails closed when the observation timestamp is missing (transport unknown)', () => {
    const d = mk().evaluate(
      ctx('BUY', { marketDataObservedAtMs: null }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe('STALE_MARKET_DATA');
      expect(d.detail).toContain('TRANSPORT_MISSING');
    }
  });

  it('fails closed on a quote timestamp ahead of the local clock beyond the skew guard', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        marketDataTimestampMs: NOW + 120_001,
        marketDataObservedAtMs: NOW,
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) {
      expect(d.reason).toBe('STALE_MARKET_DATA');
      expect(d.detail).toContain('QUOTE_AHEAD_OF_CLOCK');
    }
  });

  it('accepts a quote slightly ahead of local clock within the skew tolerance', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.25'),
        marketDataTimestampMs: NOW + 30_000,
        marketDataObservedAtMs: NOW,
      }),
    );
    expect(d.approved).toBe(true);
  });
});

// --- Gate 5: ownership (managed vs external) ---

const FEE_MARKET: MarketInfo = {
  ...marketInfo,
  feeInfo: { maker: 0.001, taker: 0.001, feeCurrency: 'quote' },
};

describe('RiskManager — SELL ownership (external is never tradable)', () => {
  it('rejects a SELL when only EXTERNAL inventory exists (bot-managed = 0)', () => {
    const d = mk().evaluate(
      ctx('SELL', { currentPosition: Money.zero(), externalPosition: Money.fromString('0.00034411') }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('SELL_EXCEEDS_MANAGED_POSITION');
  });

  it('rejects a SELL when there is neither managed nor external inventory', () => {
    const d = mk().evaluate(ctx('SELL', { currentPosition: Money.zero(), externalPosition: Money.zero() }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('NO_ACTION');
  });

  it('sells exactly the managed quantity even when external + managed coexist', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.1'),
        externalPosition: Money.fromString('1.0'),
        sellTarget: { notional: Money.fromString('100000') }, // far beyond managed
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.10000000'); // never 1.1
  });

  it('bounded sellTarget is still capped by managed inventory', () => {
    const d = mk().evaluate(
      ctx('SELL', {
        currentPosition: Money.fromString('0.1'),
        externalPosition: Money.fromString('0.0'),
        sellTarget: { notional: Money.fromString('9000') }, // 9000/40000=0.225 > 0.1
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.quantity.toFixed(8)).toBe('0.10000000');
  });
});

describe('RiskManager — managed equity & external not counted in BUY cap', () => {
  it('external holdings do not consume the managed position cap', () => {
    // Managed position 0 (external BTC exists), small managed equity. The BUY is
    // sized to the position cap over MANAGED equity; external is irrelevant.
    const d = mk().evaluate(
      ctx('BUY', {
        currentPosition: Money.zero(),
        externalPosition: Money.fromString('0.25'),
        portfolioValue: Money.fromString('1000.00'),
        peakPortfolioValue: Money.fromString('1000.00'),
        unrealizedPnlToday: Money.zero(),
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) {
      // 10% of 1000 = 100 CAD / 40000 = 0.0025 BTC.
      expect(d.quantity.toFixed(8)).toBe('0.00250000');
    }
  });

  it('does not let a large external position inflate the position cap', () => {
    const d = mk().evaluate(
      ctx('BUY', {
        currentPosition: Money.zero(),
        externalPosition: Money.fromString('5'),
        portfolioValue: Money.fromString('1000.00'),
        peakPortfolioValue: Money.fromString('1000.00'),
        unrealizedPnlToday: Money.zero(),
      }),
    );
    expect(d.approved).toBe(true);
    if (d.approved) expect(d.estimatedNotional.compareTo(Money.fromString('100.00'))).toBeLessThanOrEqual(0);
  });
});

describe('RiskManager — deployable quote & fee reservation', () => {
  it('rejects a BUY when notional + fee exceeds deployable quote (forgetting fee is unsafe)', () => {
    // deployable == notional (10000) but fee is nonzero -> not affordable.
    const d = mk().evaluate(
      ctx('BUY', {
        marketInfo: FEE_MARKET,
        deployableQuote: Money.fromString('10000.00'),
        portfolioValue: Money.fromString('100000.00'),
        quoteBalance: balance('10000'),
      }),
    );
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('INSUFFICIENT_BALANCE');
  });

  it('approves a BUY when deployable quote covers notional + fee', () => {
    // 10% cap = 10000; fee @0.1% = 10 -> need >=10010.
    const d = mk().evaluate(
      ctx('BUY', {
        marketInfo: FEE_MARKET,
        deployableQuote: Money.fromString('10010.00'),
        portfolioValue: Money.fromString('100000.00'),
        quoteBalance: balance('10010'),
      }),
    );
    expect(d.approved).toBe(true);
  });
});

describe('RiskManager — maxOpenPositions', () => {
  it('rejects a BUY when the managed portfolio is at max open positions', () => {
    const d = mk().evaluate(ctx('BUY', { openManagedPositionCount: 1 }));
    expect(d.approved).toBe(false);
    if (!d.approved) expect(d.reason).toBe('MAX_OPEN_POSITIONS');
  });

  it('allows a BUY when there is room under maxOpenPositions', () => {
    const d = mk().evaluate(ctx('BUY', { openManagedPositionCount: 0 }));
    expect(d.approved).toBe(true);
  });

  it('allows a BUY when maxOpenPositions is 0 (no limit)', () => {
    const d = mk({ maxOpenPositions: 0 }).evaluate(ctx('BUY', { openManagedPositionCount: 5 }));
    expect(d.approved).toBe(true);
  });

  it('still permits a risk-reducing SELL at max open positions', () => {
    const d = mk().evaluate(
      ctx('SELL', { currentPosition: Money.fromString('0.25'), openManagedPositionCount: 1 }),
    );
    expect(d.approved).toBe(true);
  });
});
