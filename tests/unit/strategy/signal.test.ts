import { describe, expect, it } from 'vitest';
import { signal, hold, signalToOrderSide } from '../../../src/strategy/Signal.js';

describe('Signal helpers', () => {
  it('builds a canonical signal', () => {
    const s = signal('BTC/CAD', 'BUY', { confidence: 0.7, reason: 'golden cross' }, 1234);
    expect(s).toMatchObject({
      symbol: 'BTC/CAD',
      type: 'BUY',
      confidence: 0.7,
      reason: 'golden cross',
      timestampMs: 1234,
    });
  });

  it('omits optional fields when not provided', () => {
    const s = signal('BTC/CAD', 'HOLD', {}, 9);
    expect(s.confidence).toBeUndefined();
    expect(s.reason).toBeUndefined();
    expect(s.timestampMs).toBe(9);
  });

  it('hold() is a HOLD signal', () => {
    const h = hold('BTC/CAD', 'no signal');
    expect(h.type).toBe('HOLD');
    expect(h.symbol).toBe('BTC/CAD');
  });

  it('maps signal types to order sides', () => {
    expect(signalToOrderSide('BUY')).toBe('BUY');
    expect(signalToOrderSide('SELL')).toBe('SELL');
    expect(signalToOrderSide('HOLD')).toBeNull();
  });
});
