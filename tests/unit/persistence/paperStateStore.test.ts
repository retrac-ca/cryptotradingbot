import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PORTFOLIO_STATE_VERSION } from '../../../src/portfolio/serialization.js';
import { PaperStateStore } from '../../../src/persistence/PaperStateStore.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'retrac-paper-')), 'state.json');
}

describe('PaperStateStore — minimal restart-safe persistence', () => {
  it('reports MISSING when no state file exists yet', () => {
    const store = new PaperStateStore(freshFile());
    expect(store.load().status).toBe('MISSING');
    expect(store.toPortfolio(null)).toBeNull();
  });

  it('persists and round-trips cash, positions, P&L, and executed order ids', () => {
    const cash = new Map<string, Money>();
    cash.set('CAD', Money.fromString('5000'));
    let portfolio = Portfolio.empty(cash);
    portfolio = portfolio.applyFill('BTC/CAD', 'BUY', Money.fromString('0.1'), Money.fromString('40000'), Money.fromString('20'));

    const store = new PaperStateStore(freshFile());
    store.save(portfolio.stateModel, ['a', 'b', 'c']);

    const r = store.load();
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    const file = r.data;
    expect(file.version).toBe(PORTFOLIO_STATE_VERSION);
    expect(file.cash['CAD']).toBe('980.00000000');
    expect(file.positions['BTC/CAD'].quantity).toBe('0.10000000');
    expect(file.executedOrderIds).toEqual(['a', 'b', 'c']);

    const model = store.toPortfolio(file)!;
    expect(model.positions.get('BTC/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
    expect(model.cash.get('CAD')!.toFixed(2)).toBe('980.00'); // 5000 - (4000 + 20)
    expect(model.totalFees.toFixed(2)).toBe('20.00');
  });

  it('restoring a saved portfolio yields identical equity', () => {
    const cash = new Map<string, Money>();
    cash.set('CAD', Money.fromString('100000'));
    const original = Portfolio.empty(cash).applyFill(
      'BTC/CAD',
      'BUY',
      Money.fromString('0.25'),
      Money.fromString('52000'),
      Money.zero(),
    );
    const store = new PaperStateStore(freshFile());
    store.save(original.stateModel, []);
    const r = store.load();
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    const restored = Portfolio.fromModel(store.toPortfolio(r.data)!);
    const prices = new Map<string, Money>([['BTC/CAD', Money.fromString('52000')]]);
    expect(restored.markToMarket(prices).equity.toFixed(2)).toBe(
      original.markToMarket(prices).equity.toFixed(2),
    );
  });

  it('a corrupt/version-mismatched file is CORRUPT, never MISSING', () => {
    const p = freshFile();
    rmSync(p, { force: true });
    writeFileSync(p, JSON.stringify({ version: 99, cash: 'garbage' }));
    const store = new PaperStateStore(p);
    expect(store.load().status).toBe('CORRUPT');
  });
});
