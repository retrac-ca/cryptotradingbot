import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/money/Money.js';
import {
  DonchianBreakoutStrategy,
  DEFAULT_DONCHIAN_LOOKBACK,
  createStrategy,
} from '../../../src/strategy/index.js';
import type { Candle, Timeframe } from '../../../src/types.js';
import type { StrategyContext, PositionView } from '../../../src/strategy/StrategyContext.js';

const TF: Timeframe = '5m';
const N = 3; // small lookback keeps the crafted series readable

const candle = (close: string, tsMs: number): Candle => ({
  symbol: 'BTC/CAD',
  timeframe: TF,
  timestampMs: tsMs,
  open: Money.fromString(close),
  high: Money.fromString(close),
  low: Money.fromString(close),
  close: Money.fromString(close),
  baseVolume: Money.fromString('1'),
});

const context = (
  closes: string[],
  opts: { quantity?: string; insufficientData?: boolean; now?: number } = {},
): StrategyContext => {
  const candles = closes.map((c, i) => candle(c, 1_000_000 + i * 300_000));
  const position: PositionView = {
    symbol: 'BTC/CAD',
    quantity: opts.quantity ? Money.fromString(opts.quantity) : Money.zero(),
    averageEntryPrice: opts.quantity ? Money.fromString('1') : null,
    entryAnchorPrice: null,
    realizedPnl: Money.zero(),
  };
  return {
    nowMs: opts.now ?? 5_000_000,
    symbol: 'BTC/CAD',
    ticker: null,
    candles,
    timeframe: TF,
    position,
    insufficientData: opts.insufficientData ?? false,
  };
};

describe('DonchianBreakoutStrategy', () => {
  it('sets warmupCandles = N + 1 and validates N', () => {
    expect(new DonchianBreakoutStrategy(TF, { lookbackPeriod: N }).warmupCandles).toBe(N + 1);
    expect(new DonchianBreakoutStrategy(TF, { lookbackPeriod: 4 }).warmupCandles).toBe(5);
    expect(() => new DonchianBreakoutStrategy(TF, { lookbackPeriod: 0 })).toThrow();
    expect(() => new DonchianBreakoutStrategy(TF, { lookbackPeriod: -1 })).toThrow();
    expect(() => new DonchianBreakoutStrategy(TF, { lookbackPeriod: 2.5 })).toThrow();
  });

  describe('warmup', () => {
    it('returns HOLD when insufficientData is flagged', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['1', '2', '3'], { insufficientData: true })).type).toBe('HOLD');
    });

    it('returns HOLD with fewer than N+1 candles', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      // N=3 => warmup 4; 3 candles is not enough.
      expect(s.evaluate(context(['1', '2', '3'])).type).toBe('HOLD');
    });

    it('evaluates correctly with exactly N+1 candles', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      // prior window [1,2,3], latest 4 > 3 => BUY
      expect(s.evaluate(context(['1', '2', '3', '4'])).type).toBe('BUY');
    });
  });

  describe('entry (flat)', () => {
    it('HOLD when close is below the prior N-bar high', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['1', '2', '3', '2.5'])).type).toBe('HOLD');
    });

    it('HOLD when close equals the prior N-bar high (equality is not a breakout)', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['1', '2', '3', '3'])).type).toBe('HOLD');
    });

    it('BUY when close is strictly above the prior N-bar high', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      const sig = s.evaluate(context(['1', '2', '3', '3.5']));
      expect(sig.type).toBe('BUY');
      expect(sig.symbol).toBe('BTC/CAD');
    });

    it('does not BUY while already long (no pyramiding)', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['1', '2', '3', '3.5'], { quantity: '0.5' })).type).toBe('HOLD');
    });
  });

  describe('exit (long)', () => {
    it('HOLD when close is above the prior N-bar low', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['3', '4', '5', '4'], { quantity: '0.5' })).type).toBe('HOLD');
    });

    it('HOLD when close equals the prior N-bar low (equality is not a breakdown)', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['3', '4', '5', '3'], { quantity: '0.5' })).type).toBe('HOLD');
    });

    it('SELL when close is strictly below the prior N-bar low while long', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      const sig = s.evaluate(context(['3', '4', '5', '2.5'], { quantity: '0.5' }));
      expect(sig.type).toBe('SELL');
    });

    it('does not SELL while flat', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.evaluate(context(['3', '4', '5', '2.5'])).type).toBe('HOLD');
    });
  });

  describe('window excludes the latest candle (lookahead protection)', () => {
    it('a close that is only above the window when the latest is excluded still BUYs', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      // prior [1,2,3]; latest 3.5. A window that wrongly INCLUDED the latest
      // would have high=3.5 and 3.5 > 3.5 is false => HOLD. Strict BUY proves
      // the latest candle is not in its own window.
      expect(s.evaluate(context(['1', '2', '3', '3.5'])).type).toBe('BUY');
    });

    it('a long exit only triggers because the latest is excluded from the low window', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      // prior [3,4,5]; latest 2.5. Including the latest would make low=2.5 and
      // 2.5 < 2.5 false => HOLD. Strict SELL proves exclusion.
      expect(s.evaluate(context(['3', '4', '5', '2.5'], { quantity: '0.5' })).type).toBe('SELL');
    });

    it('the signal for a prefix is unaffected by later candles', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      const prefix = ['1', '2', '3', '4'];
      const before = s.evaluate(context(prefix)).type;
      // Build and evaluate a longer series that shares the prefix; the prefix
      // decision must be identical and derivable from the prefix alone.
      s.evaluate(context([...prefix, '0', '0']));
      const after = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N }).evaluate(context(prefix)).type;
      expect(before).toBe('BUY');
      expect(after).toBe(before);
    });
  });

  describe('determinism', () => {
    it('fresh instances produce identical signals for identical context', () => {
      const closes = ['1', '2', '3', '3.5'];
      const a = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      const b = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      const sa = a.evaluate(context(closes));
      const sb = b.evaluate(context(closes));
      expect(sa.type).toBe(sb.type);
      expect(sa.reason).toBe(sb.reason);
    });

    it('does not depend on evaluation order across contexts', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      // Evaluate a long-exit context first, then a flat-entry context; the
      // second result must not be affected by the first.
      expect(s.evaluate(context(['3', '4', '5', '2.5'], { quantity: '0.5' })).type).toBe('SELL');
      expect(s.evaluate(context(['1', '2', '3', '3.5'])).type).toBe('BUY');
    });
  });

  describe('description and registration', () => {
    it('describe() identifies the strategy and fixed lookback', () => {
      const s = new DonchianBreakoutStrategy(TF, { lookbackPeriod: N });
      expect(s.id).toBe('donchian-breakout');
      expect(s.describe()).toBe('donchian-breakout(N=3)');
    });

    it('registers with the pre-registered default N=48', () => {
      const s = createStrategy('donchian-breakout', { timeframe: TF });
      expect(s.id).toBe('donchian-breakout');
      expect(createStrategy('donchian-breakout', { timeframe: TF }).describe()).toBe(
        `donchian-breakout(N=${DEFAULT_DONCHIAN_LOOKBACK})`,
      );
      const d = s as DonchianBreakoutStrategy;
      expect(d.lookbackPeriod).toBe(48);
      expect(d.warmupCandles).toBe(49);
    });
  });
});
