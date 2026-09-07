import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { PaperStateStore, ManagedStateStore } from '../../../src/persistence/index.js';
import { loadLiveManagedPortfolio } from '../../../src/cli/live-test-cmd.js';
import type { BotConfig } from '../../../src/config/schema.js';

let PAPER: string;
let LIVE: string;

function freshPaths(): { paper: string; live: string } {
  const d = mkdtempSync(join(tmpdir(), 'retrac-f1-'));
  return { paper: join(d, 'paper-state.json'), live: join(d, 'live-state.json') };
}

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    liveManagedStateFile: LIVE,
    paperStateFile: PAPER,
    ...over,
  } as BotConfig;
}

function emptyLive(): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.zero()]]));
}

function clearFiles(): void {
  rmSync(PAPER, { force: true });
  rmSync(LIVE, { force: true });
  rmSync(`${PAPER}.tmp`, { force: true });
  rmSync(`${LIVE}.tmp`, { force: true });
}

describe('F-1 — paper vs live managed state separation', () => {
  beforeEach(() => {
    const p = freshPaths();
    PAPER = p.paper;
    LIVE = p.live;
    clearFiles();
  });

  it('Test 1: a paper BTC position does NOT appear in live managed state', () => {
    const paper = new PaperStateStore(PAPER);
    const portfolio = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.25'), Money.fromString('40000'), Money.zero());
    paper.save(portfolio.stateModel, ['paper-1']);

    const live = loadLiveManagedPortfolio(cfg());
    expect(live.position('BTC/CAD')).toBeNull();
    expect(live.external('BTC/CAD').isZero()).toBe(true);
    expect(live.managedOpenCount()).toBe(0);
  });

  it('Test 2: live ETH managed state does NOT appear in paper state', () => {
    const liveStore = new ManagedStateStore(LIVE);
    const live = emptyLive().applyFill('ETH/CAD', 'BUY', Money.fromString('0.10'), Money.fromString('3000'), Money.zero());
    liveStore.save(live.stateModel);

    const paper = new PaperStateStore(PAPER);
    expect(paper.load().status).toBe('MISSING');
  });

  it('Test 3: writing paper state does NOT modify live state', () => {
    const liveStore = new ManagedStateStore(LIVE);
    const live = emptyLive().applyFill('ETH/CAD', 'BUY', Money.fromString('0.10'), Money.fromString('3000'), Money.zero());
    liveStore.save(live.stateModel);

    const paper = new PaperStateStore(PAPER);
    const paperP = Portfolio.empty(new Map([['CAD', Money.fromString('5000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('40000'), Money.zero());
    paper.save(paperP.stateModel, ['p']);
    paper.save(paperP.applyFill('BTC/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('40000'), Money.zero()).stateModel, ['p', 'p2']);

    const reloadedLive = loadLiveManagedPortfolio(cfg());
    expect(reloadedLive.position('ETH/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
    expect(reloadedLive.position('BTC/CAD')).toBeNull();
  });

  it('Test 4: writing live state does NOT modify paper state', () => {
    const paper = new PaperStateStore(PAPER);
    const paperP = Portfolio.empty(new Map([['CAD', Money.fromString('5000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.05'), Money.fromString('40000'), Money.zero());
    paper.save(paperP.stateModel, ['p']);

    const liveStore = new ManagedStateStore(LIVE);
    liveStore.save(emptyLive().applyFill('ETH/CAD', 'BUY', Money.fromString('0.10'), Money.fromString('3000'), Money.zero()).stateModel);

    const paperLoad = paper.load();
    expect(paperLoad.status).toBe('OK');
    if (paperLoad.status !== 'OK') return;
    const reloadedPaper = paper.toPortfolio(paperLoad.data);
    expect(reloadedPaper!.positions.get('BTC/CAD')!.quantity.toFixed(8)).toBe('0.05000000');
    expect(reloadedPaper!.positions.get('ETH/CAD')).toBeUndefined();
  });

  it('Test 5: missing live state NEVER falls back to paper state', () => {
    const paper = new PaperStateStore(PAPER);
    const paperP = Portfolio.empty(new Map([['CAD', Money.fromString('10000')]]))
      .applyFill('BTC/CAD', 'BUY', Money.fromString('0.25'), Money.fromString('40000'), Money.zero());
    paper.save(paperP.stateModel, ['paper-1']);
    // Intentionally do NOT write the live file.

    const live = loadLiveManagedPortfolio(cfg());
    expect(live.position('BTC/CAD')).toBeNull(); // paper BTC is NOT adopted
    expect(live.managedOpenCount()).toBe(0);
    expect(live.deployableQuote('CAD').isZero()).toBe(true); // no inferred capital
  });

  it('ManagedStateStore round-trips a live portfolio exactly', () => {
    const liveStore = new ManagedStateStore(LIVE);
    const live = emptyLive()
      .applyFill('ETH/CAD', 'BUY', Money.fromString('0.10'), Money.fromString('3000'), Money.fromString('1.5'))
      .withExternalSnapshot(new Map([['BTC/CAD', Money.fromString('0.00034411')]]));
    liveStore.save(live.stateModel);

    const r = liveStore.load();
    expect(r.status).toBe('OK');
    if (r.status !== 'OK') return;
    const recovery = liveStore.toPortfolio(r.data);
    expect(recovery!.position('ETH/CAD')!.quantity.toFixed(8)).toBe('0.10000000');
    expect(recovery!.external('BTC/CAD').toFixed(8)).toBe('0.00034411');
  });

  it('rejects config where live and paper state resolve to the same path', async () => {
    const { validateConfig } = await import('../../../src/config/schema.js');
    expect(() =>
      validateConfig({ liveManagedStateFile: 'same.json', paperStateFile: 'same.json' } as BotConfig),
    ).toThrow(/LIVE_MANAGED_STATE_FILE and PAPER_STATE_FILE must be different/);
  });

  it('accepts config where live and paper state differ', async () => {
    const { validateConfig } = await import('../../../src/config/schema.js');
    expect(() =>
      validateConfig({ liveManagedStateFile: 'a.json', paperStateFile: 'b.json' } as BotConfig),
    ).not.toThrow();
  });
});
