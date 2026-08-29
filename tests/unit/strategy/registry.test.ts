import { describe, expect, it, afterEach } from 'vitest';
import {
  createStrategy,
  getSupportedStrategies,
  isStrategySupported,
  registerStrategy,
  resetStrategyRegistry,
} from '../../../src/strategy/registry.js';
import { MovingAverageCrossoverStrategy } from '../../../src/strategy/movingAverageCrossover.js';

afterEach(() => {
  resetStrategyRegistry();
});

describe('strategy registry', () => {
  it('exposes registered strategies', () => {
    registerStrategy('test-strat', () => new MovingAverageCrossoverStrategy('5m', { fastPeriod: 2, slowPeriod: 3 }));
    expect(isStrategySupported('test-strat')).toBe(true);
    expect(getSupportedStrategies()).toContain('test-strat');
  });

  it('creates a strategy from a registered factory', () => {
    registerStrategy('test-strat', () => new MovingAverageCrossoverStrategy('5m', { fastPeriod: 2, slowPeriod: 3 }));
    const s = createStrategy('test-strat', { timeframe: '5m', fastPeriod: 2, slowPeriod: 3 });
    expect(s.id).toBe('moving-average-crossover');
  });

  it('throws for an unknown strategy with a helpful message', () => {
    expect(() => createStrategy('does-not-exist', { timeframe: '5m' })).toThrow(/does-not-exist/);
  });

  it('reports an unknown strategy as unsupported', () => {
    expect(isStrategySupported('nope')).toBe(false);
  });
});
