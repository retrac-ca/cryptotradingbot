import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PaperStateStore } from '../../../src/persistence/PaperStateStore.js';

const STATE_FILE = '/tmp/opencode/paper-state-test.json';

describe('PaperStateStore — minimal restart-safe persistence', () => {
  it('returns null when no state file exists yet', () => {
    rmSync(STATE_FILE, { force: true });
    const store = new PaperStateStore(STATE_FILE);
    expect(store.load()).toBeNull();
    expect(store.toPortfolio(null)).toBeNull();
  });

  it('persists and round-trips cash, positions, P&L, and executed order ids', () => {
    rmSync(STATE_FILE, { force: true });
    const cash = new Map<string, Money>();
    cash.set('CAD', Money.fromString('5000'));
    let portfolio = Portfolio.empty(cash);
    portfolio = portfolio.applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.fromString('20'));

    const store = new PaperStateStore(STATE_FILE);
    store.save(portfolio.stateModel, ['a', 'b', 'c']);

    const file = store.load()!;
    expect(file.version).toBe(1);
    expect(file.cash['CAD']).toBe('980.00000000');
    expect(file.positions['BTC/CAD'].quantity).toBe('0.10000000');
    expect(file.executedOrderIds).toEqual(['a', 'b', 'c']);
    expect(file.savedAtMs).toBeGreaterThan(0);

    const model = store.toPortfolio(file)!;
    expect(model.positions.get('BTC/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
    expect(model.cash.get('CAD')!.toFixed(2)).toBe('980.00'); // 5000 - (4000 + 20)
    expect(model.totalFees.toFixed(2)).toBe('20.00');
  });

  it('restoring a saved portfolio yields identical equity', () => {
    rmSync(STATE_FILE, { force: true });
    const cash = new Map<string, Money>();
    cash.set('CAD', Money.fromString('100000'));
    const original = Portfolio.empty(cash).applyFill(
      'BTC/CAD',
      'BUY',
      Money.fromString('0.25'),
      Money.fromString('52000'),
      Money.zero(),
    );
    const store = new PaperStateStore(STATE_FILE);
    store.save(original.stateModel, []);
    const restored = Portfolio.fromModel(store.toPortfolio(store.load())!);
    const prices = new Map<string, Money>([['BTC/CAD', Money.fromString('52000')]]);
    expect(restored.markToMarket(prices).equity.toFixed(2)).toBe(
      original.markToMarket(prices).equity.toFixed(2),
    );
  });

  it('toPortfolio returns null on a corrupt/version-mismatched file', () => {
    const bad = '/tmp/opencode/paper-state-bad.json';
    rmSync(bad, { force: true });
    writeFileSync(bad, JSON.stringify({ version: 99, cash: 'garbage' }));
    const store = new PaperStateStore(bad);
    expect(store.toPortfolio(store.load())).toBeNull();
    rmSync(bad, { force: true });
  });
});
