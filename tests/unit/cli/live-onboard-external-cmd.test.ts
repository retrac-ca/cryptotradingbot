/**
 * `bot live-onboard-external` — inventory onboarding / ownership authorization.
 *
 * This command authorizes existing EXTERNAL exchange inventory as bot-managed
 * (EXTERNAL_AUTHORIZED, zero cost basis). It must ONLY mutate the local LIVE
 * managed portfolio, never the exchange. These tests verify the safety boundary
 * without ever contacting a real exchange (FakeExchange only).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { Money } from '../../../src/money/Money.js';
import { Portfolio } from '../../../src/portfolio/Portfolio.js';
import { botConfigSchema } from '../../../src/config/schema.js';
import {
  executeLiveOnboardExternal,
  parseLiveOnboardExternalArgs,
} from '../../../src/cli/live-onboard-external-cmd.js';
import { FakeExchange } from '../../fakes/FakeExchange.js';
import type { BotConfig } from '../../../src/config/schema.js';
import type { MarketInfo } from '../../../src/types.js';
import { statePath } from '../../helpers/state.js';

const LEDGER = statePath('live-onboard', 'ledger.json');
const SYMBOL = 'BTC/CAD';

const market: MarketInfo = {
  symbol: SYMBOL,
  exchangeId: '1',
  priceTick: Money.fromString('0.01'),
  basePrecision: 8,
  quotePrecision: 2,
  quantityTick: Money.fromString('0.00000001'),
  minOrderBase: Money.fromString('0'),
  minOrderQuote: Money.fromString('1'),
  supportsMarketOrders: true,
  feeInfo: { maker: 0.002, taker: 0.002, feeCurrency: 'quote' },
};

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    tradingMode: 'live',
    realFundsAtRisk: true,
    exchange: 'ndax',
    ndaxApiKey: '',
    ndaxApiSecret: '',
    ndaxUserId: '',
    ndaxUserName: '',
    enableAuthenticatedReads: true,
    tradingPairs: [SYMBOL],
    strategy: 'moving-average-crossover',
    timeframe: '5m',
    maFastPeriod: 5,
    maSlowPeriod: 10,
    maxPositionSizeFraction: 0.1,
    maxTradeAmount: 0,
    stopLossFraction: 0.05,
    takeProfitFraction: 0.1,
    maxDailyLossFraction: 0.05,
    maxOpenPositions: 1,
    cooldownAfterLossSeconds: 3600,
    maxPortfolioExposureFraction: 0.5,
    maxDrawdownFraction: 0.1,
    marketDataMaxAgeMs: 60000,
    marketDataTransportMaxAgeMs: 60000,
    maxClockSkewMs: 120000,
    paperStartingBalance: 10000,
    liveMaxBaseQuantity: 0.01,
    liveMaxQuoteNotional: 100,
    liveMonitorIntervalSeconds: 30,
    logLevel: 'info',
    reconcileIntervalSeconds: 60,
    killSwitch: false,
    orderLedgerFile: LEDGER,
    ...over,
  } as BotConfig;
}

function makePortfolio(): Portfolio {
  return Portfolio.empty(new Map([['CAD', Money.fromString('100000')]]));
}

interface BuiltDeps {
  deps: Parameters<typeof executeLiveOnboardExternal>[0];
  exchange: FakeExchange;
  saved: Portfolio[];
  getPortfolio: () => Portfolio;
}

function buildDeps(over: {
  cfg?: Partial<BotConfig>;
  balance?: string;
  portfolio?: Portfolio;
  confirm?: (message: string) => Promise<boolean>;
} = {}): BuiltDeps {
  const c = cfg(over.cfg);
  const exchange = new FakeExchange({
    balances: { BTC: over.balance ?? '0.00034411', CAD: '100000' },
    markets: { [SYMBOL]: market },
  });
  let portfolio = over.portfolio ?? makePortfolio();
  const saved: Portfolio[] = [];
  const deps = {
    cfg: c,
    adapter: exchange,
    getPortfolio: () => portfolio,
    savePortfolio: (p: Portfolio) => {
      portfolio = p;
      saved.push(p);
    },
    confirm: over.confirm ?? (async () => true),
    nowMs: () => 1_000_000,
  };
  return { deps, exchange, saved, getPortfolio: () => portfolio };
}

describe('live-onboard-external — safety gates', () => {
  it('refuses to operate against PAPER state', async () => {
    const { deps } = buildDeps({ cfg: { tradingMode: 'paper' } });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(deps.getPortfolio().position(SYMBOL)).toBeNull();
  });

  it('requires live mode', async () => {
    const { deps } = buildDeps();
    expect(deps.cfg.tradingMode).toBe('live');
  });

  it('preserves the kill switch (refuses when active)', async () => {
    const { deps } = buildDeps({ cfg: { killSwitch: true } });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(deps.getPortfolio().position(SYMBOL)).toBeNull();
  });

  it('requires authenticated exchange reads', async () => {
    const { deps } = buildDeps({ cfg: { enableAuthenticatedReads: false } });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(deps.getPortfolio().position(SYMBOL)).toBeNull();
  });

  it('requires exactly one configured trading pair', async () => {
    const { deps } = buildDeps({ cfg: { tradingPairs: [SYMBOL, 'ETH/CAD'] } });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
  });
});

describe('live-onboard-external — exchange read & quantity', () => {
  it('observes the external exchange BTC', async () => {
    const { deps } = buildDeps({ balance: '0.00034411' });
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    const pos = deps.getPortfolio().position(SYMBOL)!;
    expect(pos.quantity.toFixed(8)).toBe('0.00034411');
  });

  it('never authorizes more than the verified exchange balance', async () => {
    const { deps } = buildDeps({ balance: '0.00034411' });
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    const pos = deps.getPortfolio().position(SYMBOL)!;
    expect(pos.quantity.compareTo(Money.fromString('0.00034411'))).toBe(0);
    expect(pos.quantity.compareTo(Money.fromString('0.001'))).toBeLessThan(0);
  });

  it('rejects when the exchange reports zero external quantity', async () => {
    const { deps } = buildDeps({ balance: '0' });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(deps.getPortfolio().position(SYMBOL)).toBeNull();
  });

  it('rejects when the managed position already covers the exchange balance', async () => {
    const portfolio = makePortfolio().applyFill(SYMBOL, 'BUY', Money.fromString('0.001'), Money.fromString('40000'), Money.zero());
    const { deps } = buildDeps({ portfolio, balance: '0.00034411' });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(deps.getPortfolio().position(SYMBOL)!.quantity.toFixed(8)).toBe('0.00100000');
  });
});

describe('live-onboard-external — confirmation', () => {
  it('requires operator confirmation (declining aborts without persisting)', async () => {
    const { deps, saved } = buildDeps({ confirm: async () => false });
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(saved).toHaveLength(0);
    expect(deps.getPortfolio().position(SYMBOL)).toBeNull();
  });
});

describe('live-onboard-external — successful authorization', () => {
  it('authorizes the full external quantity as EXTERNAL_AUTHORIZED', async () => {
    const { deps } = buildDeps();
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    const pos = deps.getPortfolio().position(SYMBOL)!;
    expect(pos.source).toBe('EXTERNAL_AUTHORIZED');
    expect(pos.sourceQuantities.EXTERNAL_AUTHORIZED.toFixed(8)).toBe('0.00034411');
    expect(pos.sourceQuantities.BOT.toFixed(8)).toBe('0.00000000');
  });

  it('preserves zero cost basis', async () => {
    const { deps } = buildDeps();
    await executeLiveOnboardExternal(deps);
    const pos = deps.getPortfolio().position(SYMBOL)!;
    expect(pos.costBasis.toFixed(8)).toBe('0.00000000');
    expect(pos.averageEntryPrice.toFixed(8)).toBe('0.00000000');
  });

  it('consumes the external snapshot entry', async () => {
    const { deps } = buildDeps();
    await executeLiveOnboardExternal(deps);
    expect(deps.getPortfolio().external(SYMBOL).toFixed(8)).toBe('0.00000000');
    expect(deps.getPortfolio().externalSnapshotView().has(SYMBOL)).toBe(false);
  });

  it('keeps expectedAssetBalances coherent with the exchange', async () => {
    const { deps } = buildDeps();
    await executeLiveOnboardExternal(deps);
    const expected = deps.getPortfolio().expectedAssetBalances();
    expect(expected.get('BTC')!.toFixed(8)).toBe('0.00034411');
  });

  it('does not create a reservation, applied execution, or manual settlement', async () => {
    const { deps } = buildDeps();
    await executeLiveOnboardExternal(deps);
    const model = deps.getPortfolio().stateModel;
    expect(model.orderReservations.size).toBe(0);
    expect(model.appliedExecutions.size).toBe(0);
    expect(model.manualSettlements.size).toBe(0);
  });

  it('does not mutate the order ledger', async () => {
    rmSync(LEDGER, { force: true });
    const { deps } = buildDeps();
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    expect(existsSync(LEDGER)).toBe(false);
  });
});

describe('live-onboard-external — idempotency', () => {
  it('re-running after authorization fails safely without duplicating inventory', async () => {
    const { deps } = buildDeps();
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    const pos = deps.getPortfolio().position(SYMBOL)!;
    expect(pos.quantity.toFixed(8)).toBe('0.00034411');
  });
});

describe('live-onboard-external — TOCTOU', () => {
  it('fails closed when the external balance changes after confirmation', async () => {
    const c = cfg();
    const exchange = new FakeExchange({
      balances: { BTC: '0.00034411', CAD: '100000' },
      markets: { [SYMBOL]: market },
    });
    let portfolio = makePortfolio();
    const saved: Portfolio[] = [];
    const deps = {
      cfg: c,
      adapter: exchange,
      getPortfolio: () => portfolio,
      savePortfolio: (p: Portfolio) => {
        portfolio = p;
        saved.push(p);
      },
      // The balance changes AFTER the first read (during confirmation).
      confirm: async () => {
        exchange.setBalance('BTC', '0.00050000');
        return true;
      },
      nowMs: () => 1_000_000,
    };
    expect(await executeLiveOnboardExternal(deps)).toBe(1);
    expect(saved).toHaveLength(0);
    expect(portfolio.position(SYMBOL)).toBeNull();
  });
});

describe('live-onboard-external — no mutation path', () => {
  it('does not place or cancel any order', async () => {
    const { deps, exchange } = buildDeps();
    expect(await executeLiveOnboardExternal(deps)).toBe(0);
    expect(exchange.submittedOrders).toHaveLength(0);
  });
});

describe('live-onboard-external — no bypass', () => {
  it('rejects --yes / --force and any arguments (no bypass)', () => {
    expect(parseLiveOnboardExternalArgs(['--yes']).ok).toBe(false);
    expect(parseLiveOnboardExternalArgs(['--force']).ok).toBe(false);
    expect(parseLiveOnboardExternalArgs(['--confirm']).ok).toBe(false);
    expect(parseLiveOnboardExternalArgs([]).ok).toBe(true);
  });

  it('no config/env schema field can authorize inventory unattended', () => {
    const shape = botConfigSchema.shape as Record<string, unknown>;
    expect(shape).not.toHaveProperty('authorizeExternal');
    expect(shape).not.toHaveProperty('onboardExternal');
    expect(shape).not.toHaveProperty('adoptExternal');
    expect(shape).not.toHaveProperty('liveOnboardExternal');
  });
});
